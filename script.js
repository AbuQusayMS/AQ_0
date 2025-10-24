const ICON_SUN = '\u2600\uFE0F';
const ICON_MOON = '\uD83C\uDF19';
 
class QuizGame {
    constructor() {
        this.config = {
            SUPABASE_URL: 'https://sngetxkrlizksgjiovbs.supabase.co', // ضع رابط خادم Supabase الرئيسي هنا
            SUPABASE_KEY: 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InNuZ2V0eGtybGl6a3NnamlvdmJzIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NjEyOTYyNzEsImV4cCI6MjA3Njg3MjI3MX0.XIFw-huu8_uLtY16ILpXCU6us4jyqEpfagVRqj1l-EI', // ضع مفتاح الخادم الرئيسي هنا
            EDGE_SAVE_URL: '###', // ضع رابط دالة حفظ النتائج هنا
            EDGE_LOG_URL: '###', // ضع رابط دالة السجلات هنا
            EDGE_REPORT_URL: '###', // ضع رابط دالة البلاغات هنا
            EDGE_LEADERBOARD_URL: '###', // ضع رابط دالة لوحة الصدارة هنا
            APP_KEY: 'MS_AbuQusay',
            QUESTIONS_URL: 'https://raw.githubusercontent.com/AbuQusayMS/AQ_0/main/questions.json', // ضع رابط ملف الأسئلة هنا

            QUESTION_TIME: 80,
            MAX_WRONG_ANSWERS: 3,
            STARTING_SCORE: 100,

            LEVELS: [
                { name: 'easy', label: 'سهل' },
                { name: 'medium', label: 'متوسط' },
                { name: 'hard', label: 'صعب' },
                { name: 'impossible', label: 'مستحيل' }
            ],

            HELPER_COSTS: { fiftyFifty: 100, freezeTime: 100, skipQuestionBase: 0, skipQuestionIncrement: 0 },
            SKIP_WEIGHT: 0.7,
            CLICK_DEBOUNCE_MS: 600,
            COOLDOWN_SECONDS: 30,
            REQ_TIMEOUT_MS: 10000
        };

        this.initializeGameState();
        this.setupErrorHandling();
        this.setupBackButtonHandler();
        this.init();
    }

    initializeGameState() {
        this.questions = {};
        this.gameState = {};
        this.timer = { interval: null, isFrozen: false, total: 0 };
        this.dom = {};
        this.cropper = null;
        this.leaderboardSubscription = null;
        this.recentErrors = [];
        this.audioCache = new Map();
        this.currentSessionId = this.generateSessionId();
        this.cleanupQueue = [];
        this.answerSubmitted = false;
        this.pendingRequests = new Set();
        this.lbFirstOpenDone = false;
        this.idempotency = new Set();
        this.lastActionAt = new Map();

        this.performanceMetrics = {
            startTime: 0,
            questionsAnswered: 0,
            totalTimeSpent: 0
        };
        this.imageCache = new Map();
        this.retryQueue = [];
    }

    cacheDomElements() {
        const byId = (id) => document.getElementById(id);
        this.dom = {
            screens: {
                loader: byId('loader'),
                start: byId('startScreen'),
                avatar: byId('avatarScreen'),
                nameEntry: byId('nameEntryScreen'),
                instructions: byId('instructionsScreen'),
                game: byId('gameContainer'),
                levelComplete: byId('levelCompleteScreen'),
                end: byId('endScreen'),
                leaderboard: byId('leaderboardScreen')
            },
            modals: {
                confirmExit: byId('confirmExitModal'),
                advancedReport: byId('advancedReportModal'),
                avatarEditor: byId('avatarEditorModal'),
                playerDetails: byId('playerDetailsModal')
            },
            nameInput: byId('nameInput'),
            nameError: byId('nameError'),
            confirmNameBtn: byId('confirmNameBtn'),
            confirmAvatarBtn: byId('confirmAvatarBtn'),
            reportProblemForm: byId('reportProblemForm'),
            imageToCrop: byId('image-to-crop'),
            leaderboardContent: byId('leaderboardContent'),
            questionText: byId('questionText'),
            optionsGrid: this.getEl('.options-grid'),
            scoreDisplay: byId('currentScore'),
            reportFab: byId('reportErrorFab'),
            problemScreenshot: byId('problemScreenshot'),
            reportImagePreview: byId('reportImagePreview'),
            includeAutoDiagnostics: byId('includeAutoDiagnostics'),
            lbMode: byId('lbMode'),
            lbAttempt: byId('lbAttempt'),
            retryHint: byId('retryHint'),
            retryCountdown: byId('retryCountdown'),
            startBtn: byId('startBtn')
        };
    }

    getEl(selector, parent = document) {
        return parent.querySelector(selector);
    }

    getAllEl(selector, parent = document) {
        return Array.from(parent.querySelectorAll(selector));
    }

    bindEventListeners() {
        document.body.addEventListener('click', (e) => {
            const target = e.target.closest('[data-action]');
            if (!target) return;
            const action = target.dataset.action;

            const actionHandlers = {
                showAvatarScreen: () => this.startFromHomeGuarded(target),
                showNameEntryScreen: () => this.showScreen('nameEntry'),
                confirmName: () => this.handleNameConfirmation(),
                postInstructionsStart: () => this.postInstructionsStartGuarded(target),
                showLeaderboard: () => this.displayLeaderboard(),
                showStartScreen: () => this.showScreen('start'),
                toggleTheme: () => this.toggleTheme(),
                showConfirmExitModal: () => this.showModal('confirmExit'),
                closeModal: () => {
                    const id = target.dataset.modalId || target.dataset.modalKey;
                    if (id === 'avatarEditor' || id === 'avatarEditorModal') this.cleanupAvatarEditor();
                    this.hideModal(id);
                },
                endGame: () => this.endGame(),
                nextLevel: () => this.nextLevel(),
                playAgain: () => this.playAgainGuarded(target),
                shareOnX: () => this.shareOnX(),
                shareOnInstagram: () => this.shareOnInstagram(),
                saveCroppedAvatar: () => this.saveCroppedAvatar()
            };

            if (actionHandlers[action]) {
                this.playSound('click');
                actionHandlers[action]();
            }
        });

        this.dom.nameInput?.addEventListener('input', () => this.validateNameInput());
        this.dom.nameInput?.addEventListener('keypress', (e) => {
            if (e.key === 'Enter') this.handleNameConfirmation();
        });

        this.dom.reportProblemForm?.addEventListener('submit', (e) => this.handleReportSubmit(e));

        if (this.dom.optionsGrid) {
            this.dom.optionsGrid.addEventListener('click', (e) => {
                const btn = e.target.closest('.option-btn');
                if (!btn) return;
                this.getAllEl('.option-btn').forEach(b => b.classList.add('disabled'));
                this.checkAnswer(btn);
            });
        }

        const helpersEl = this.getEl('.helpers');
        if (helpersEl) {
            helpersEl.addEventListener('click', (e) => {
                const btn = e.target.closest('.helper-btn');
                if (btn) this.useHelper(btn);
            });
        }

        const avatarGrid = this.getEl('.avatar-grid');
        if (avatarGrid) {
            avatarGrid.addEventListener('click', (e) => {
                if (e.target.matches('.avatar-option')) this.selectAvatar(e.target);
            });
        }

        if (this.dom.reportFab) this.dom.reportFab.addEventListener('click', () => this.showModal('advancedReport'));

        document.querySelectorAll('.modal').forEach(modal => {
            modal.addEventListener('click', (e) => {
                if (e.target.classList.contains('modal')) {
                    const modalId = modal.id;
                    if (modalId === 'avatarEditorModal') this.cleanupAvatarEditor();
                    modal.classList.remove('active');
                }
            });
        });

        this.dom.problemScreenshot?.addEventListener('change', (e) => {
            const file = e.target.files?.[0];
            const prev = this.dom.reportImagePreview;
            if (!file) {
                prev.style.display = 'none';
                prev.querySelector('img').src = '';
                return;
            }
            const url = URL.createObjectURL(file);
            prev.style.display = 'block';
            prev.querySelector('img').src = url;
            this.cleanupQueue.push({ type: 'url', value: url });
        });

        document.addEventListener('keydown', (e) => {
            if (e.key === 'Escape') {
                const open = document.querySelector('.modal.active');
                if (open) {
                    const modalId = open.id;
                    if (modalId === 'avatarEditorModal') this.cleanupAvatarEditor();
                    open.classList.remove('active');
                }
            }
        });

        this.dom.lbMode?.addEventListener('change', () => {
            const m = this.dom.lbMode.value;
            if (this.dom.lbAttempt) this.dom.lbAttempt.disabled = (m !== 'attempt');
            this.displayLeaderboard();
        });
        this.dom.lbAttempt?.addEventListener('change', () => this.displayLeaderboard());

        window.addEventListener('online', () => this.handleOnlineStatus());
        window.addEventListener('offline', () => this.handleOfflineStatus());
    }

    async preloadAudio() {
        const audioFiles = {
            correct: '###', // ضع رابط الصوت للإجابة الصحيحة
            wrong: '###',   // ضع رابط الصوت للإجابة الخاطئة
            levelup: '###', // ضع رابط الصوت لانتهاء المستوى
            win: '###',     // ضع رابط الصوت للفوز
            loss: '###',    // ضع رابط الصوت للخسارة
            start: '###',   // ضع رابط الصوت للبدء
            click: '###',   // ضع رابط الصوت للنقر
            notify: '###',  // ضع رابط الصوت للإشعار
            coin: '###',    // ضع رابط الصوت للعملة
            fadeout: '###', // ضع رابط الصوت للتلاشي
            whoosh: '###'   // ضع رابط الصوت للصوت السريع
        };

        const loadPromises = [];
        for (const [key, path] of Object.entries(audioFiles)) {
            const loadPromise = new Promise((resolve) => {
                try {
                    const audio = new Audio();
                    audio.preload = 'auto';
                    audio.src = path;
                    audio.oncanplaythrough = () => resolve();
                    audio.onerror = () => resolve();
                    this.audioCache.set(key, audio);
                } catch (_) {
                    resolve();
                }
            });
            loadPromises.push(loadPromise);
        }

        await Promise.allSettled(loadPromises);
    }

    playSound(name) {
        try {
            const audio = this.audioCache.get(name);
            if (audio) {
                const c = audio.cloneNode();
                c.volume = 0.7;
                c.play().catch(() => { });
            }
        } catch (_) { }
    }

    generateSessionId() {
        return `S${Date.now()}_${Math.random().toString(36).substring(2, 11)}`;
    }

    setupErrorHandling() {
        window.addEventListener('error', (ev) => {
            const error = {
                type: 'error',
                message: String(ev.message || ''),
                source: ev.filename || '',
                line: ev.lineno || 0,
                col: ev.colno || 0,
                time: new Date().toISOString()
            };
            this.recentErrors.push(error);
            this.recentErrors = this.recentErrors.slice(-10);
        });

        window.addEventListener('unhandledrejection', (ev) => {
            const error = {
                type: 'unhandledrejection',
                reason: String(ev.reason || ''),
                time: new Date().toISOString()
            };
            this.recentErrors.push(error);
            this.recentErrors = this.recentErrors.slice(-10);
        });
    }

    setupBackButtonHandler() {
        window.addEventListener('popstate', () => { this.handleBackButton(); });
    }

    handleBackButton() {
        const activeScreen = this.getEl('.screen.active');
        if (!activeScreen) return;
        const screenId = activeScreen.id;

        switch (screenId) {
            case 'startScreen': break;
            case 'avatarScreen':
            case 'nameEntryScreen':
            case 'instructionsScreen':
                if (screenId === 'instructionsScreen') this.showScreen('nameEntry');
                else if (screenId === 'nameEntryScreen') this.showScreen('avatar');
                else if (screenId === 'avatarScreen') this.showScreen('start');
                break;
            case 'gameContainer': this.showModal('confirmExit'); break;
            case 'levelCompleteScreen':
            case 'endScreen':
            case 'leaderboardScreen': this.showScreen('start'); break;
            default:
                const openModal = document.querySelector('.modal.active');
                if (openModal) {
                    const modalId = openModal.id;
                    if (modalId === 'avatarEditorModal') this.cleanupAvatarEditor();
                    this.hideModal(modalId);
                } else {
                    this.showScreen('start');
                }
        }
    }

    async init() {
        this.cacheDomElements();
        this.bindEventListeners();
        this.populateAvatarGrid();
        await this.preloadAudio();

        await this.retryFailedSubmissions();

        const ok = await this.loadQuestions();
        if (ok) {
            this.showScreen('start');
        } else {
            const lt = this.getEl('#loaderText');
            if (lt) lt.textContent = 'حدث خطأ في تحميل الأسئلة. الرجاء تحديث الصفحة.';
        }
        this.dom.screens.loader?.classList.remove('active');
    }

    showScreen(screenName) {
        Object.values(this.dom.screens).forEach(s => s?.classList?.remove('active'));
        const el = this.dom.screens[screenName];
        if (el) {
            el.classList.add('active');
            const id = el.id;
            if (['gameContainer', 'leaderboardScreen', 'endScreen'].includes(id)) {
                history.pushState({ screen: id }, '', `#${id}`);
            }

            if (screenName === 'start') this.startStartCooldownUI();
        }
    }

    showModal(nameOrId) {
        const modal = this.dom.modals[nameOrId] || document.getElementById(nameOrId);
        if (modal) {
            modal.classList.add('active');
        }
    }

    hideModal(nameOrId) {
        const modal = this.dom.modals[nameOrId] || document.getElementById(nameOrId);
        if (modal) {
            modal.classList.remove('active');
        }
    }

    showToast(message, type = 'info') {
        const c = this.getEl('#toast-container');
        if (!c) return;

        const t = document.createElement('div');
        t.className = `toast ${type}`;
        t.textContent = message;
        t.setAttribute('role', 'alert');
        c.appendChild(t);

        setTimeout(() => {
            if (t.parentNode === c) {
                c.removeChild(t);
            }
        }, 3000);
    }

    toggleTheme() {
        const newTheme = document.body.dataset.theme === 'dark' ? 'light' : 'dark';
        document.body.dataset.theme = newTheme;
        localStorage.setItem('theme', newTheme);
        this.getEl('.theme-toggle-btn').textContent = (newTheme === 'dark') ? ICON_SUN : ICON_MOON;
    }

    updateLevelProgressUI() {
        this.getAllEl('.level-indicator').forEach((ind, i) => {
            ind.classList.toggle('active', i === this.gameState.level);
            ind.classList.toggle('completed', i < this.gameState.level);
        });
    }

    handleOnlineStatus() {
        this.showToast('تم استعادة الاتصال', 'success');
        this.retryFailedSubmissions();
    }

    handleOfflineStatus() {
        this.showToast('أنت غير متصل بالإنترنت', 'warning');
    }

    preloadImages(urls) {
        urls.forEach(url => {
            if (!this.imageCache.has(url)) {
                const img = new Image();
                img.src = url;
                this.imageCache.set(url, img);
            }
        });
    }
}

Object.assign(QuizGame.prototype, {
    postInstructionsStart: async function () {
        await this.cleanupSession();
        this.setupInitialGameState();
        this.startGameFlow(0);
    },

    setupInitialGameState: function () {
        this.gameState = {
            name: (this.dom.nameInput?.value || '').trim(),
            avatar: this.gameState.avatar,
            playerId: `PL${Math.random().toString(36).substring(2, 11).toUpperCase()}`,
            deviceId: this.getOrSetDeviceId(),
            sessionId: this.generateSessionId(),
            level: 0,
            questionIndex: 0,
            wrongAnswers: 0,
            correctAnswers: 0,
            skips: 0,
            startTime: new Date(),
            helpersUsed: { fiftyFifty: false, freezeTime: false },
            currentScore: this.config.STARTING_SCORE,
            shuffledQuestions: {},
            attemptNumber: null
        };

        this.performanceMetrics.startTime = Date.now();
        this.performanceMetrics.questionsAnswered = 0;
        this.performanceMetrics.totalTimeSpent = 0;
    },

    startGameFlow: function (levelIndex = 0) {
        this.gameState.level = levelIndex;
        this.updateScore(this.config.STARTING_SCORE, true);
        this.setupGameUI();
        this.showScreen('game');
        this.playSound('start');
        this.startLevel();
    },

    startLevel: function () {
        const currentLevel = this.config.LEVELS[this.gameState.level];
        this.gameState.helpersUsed = { fiftyFifty: false, freezeTime: false };
        document.body.dataset.level = currentLevel.name;
        this.getEl('#currentLevelBadge').textContent = currentLevel.label;

        const levelQuestions = this.getLevelQuestions(currentLevel.name);
        if (levelQuestions.length > 0) {
            this.shuffleArray(levelQuestions);
            this.gameState.shuffledQuestions = levelQuestions;
        } else {
            console.warn('No questions for level:', currentLevel.name);
            this.gameState.shuffledQuestions = [];
        }

        this.updateLevelProgressUI();
        this.gameState.questionIndex = 0;
        this.fetchQuestion();
    },

    fetchQuestion: function () {
        const questions = this.gameState.shuffledQuestions || [];
        if (this.gameState.questionIndex >= questions.length) {
            this.levelComplete();
            return;
        }
        const q = questions[this.gameState.questionIndex];
        this.displayQuestion(q);
    },

    displayQuestion: function (qData) {
        this.answerSubmitted = false;
        const { text, options, correctText } = this.resolveQuestionFields(qData);

        const safeOptions = Array.isArray(options) ? options.slice() : [];
        if (!text || safeOptions.length === 0) {
            this.showToast('تم تجاوز سؤال غير صالح', 'error');
            this.gameState.skips++;
            this.gameState.questionIndex++;
            return this.fetchQuestion();
        }

        const totalQuestions = (this.gameState.shuffledQuestions || []).length;
        this.getEl('#questionCounter').textContent = `السؤال ${this.gameState.questionIndex + 1} من ${totalQuestions}`;
        this.dom.questionText.textContent = text;
        this.dom.optionsGrid.innerHTML = '';

        let displayOptions = [...safeOptions];
        if (displayOptions.length > 0) this.shuffleArray(displayOptions);

        const frag = document.createDocumentFragment();
        displayOptions.forEach(opt => {
            const btn = document.createElement('button');
            btn.className = 'option-btn';
            btn.textContent = opt;
            btn.dataset.correct = (this.normalize(opt) === this.normalize(correctText));
            frag.appendChild(btn);
        });
        this.dom.optionsGrid.appendChild(frag);

        this.updateGameStatsUI();
        this.startTimer();
    },

    checkAnswer: async function (selectedButton = null) {
        if (this.answerSubmitted) return;
        this.answerSubmitted = true;
        clearInterval(this.timer.interval);
        this.getAllEl('.option-btn').forEach(b => b.classList.add('disabled'));

        let isCorrect = false;
        if (selectedButton?.dataset) isCorrect = selectedButton.dataset.correct === 'true';

        if (isCorrect) {
            selectedButton.classList.add('correct');
            this.updateScore(this.gameState.currentScore + 100);
            this.gameState.correctAnswers++;
            this.playSound('correct');
            this.showToast('إجابة صحيحة! +100 نقطة', 'success');
        } else {
            selectedButton?.classList.add('wrong');
            const correctButton = this.dom.optionsGrid.querySelector('[data-correct="true"]');
            correctButton?.classList.add('correct');
            this.gameState.wrongAnswers++;
            this.updateScore(this.gameState.currentScore - 100);
            this.playSound('wrong');
            this.showToast('إجابة خاطئة! -100 نقطة', 'error');
        }

        this.performanceMetrics.questionsAnswered++;
        this.performanceMetrics.totalTimeSpent += (this.config.QUESTION_TIME - this.timer.total);

        this.gameState.questionIndex++;
        this.updateGameStatsUI();

        const isGameOver = this.gameState.wrongAnswers >= this.config.MAX_WRONG_ANSWERS;
        const tid = setTimeout(() => {
            isGameOver ? this.endGame(false) : this.fetchQuestion();
        }, 2000);
        this.cleanupQueue.push({ type: 'timeout', id: tid });
    },

    levelComplete: function () {
        const isLast = this.gameState.level >= this.config.LEVELS.length - 1;
        if (isLast) {
            this.endGame(true);
            return;
        }

        this.getEl('#levelCompleteTitle').textContent = `🎉 أكملت المستوى ${this.config.LEVELS[this.gameState.level].label}!`;
        this.getEl('#levelScore').textContent = this.formatNumber(this.gameState.currentScore);
        this.getEl('#levelErrors').textContent = this.gameState.wrongAnswers;
        this.getEl('#levelCorrect').textContent = this.gameState.correctAnswers;
        this.playSound('levelup');
        this.showScreen('levelComplete');
    },

    nextLevel: function () {
        this.gameState.level++;
        if (this.gameState.level >= this.config.LEVELS.length) {
            this.endGame(true);
        } else {
            this.showScreen('game');
            this.startLevel();
        }
    },

    startTimer: function () {
        clearInterval(this.timer.interval);
        this.timer.total = this.config.QUESTION_TIME;
        let timeLeft = this.timer.total;

        const bar = this.getEl('.timer-bar');
        const label = this.getEl('.timer-text');
        if (!bar || !label) return;

        label.textContent = timeLeft;
        bar.style.transition = 'width 200ms linear';
        bar.style.width = '100%';

        const update = () => {
            if (this.timer.isFrozen) return;
            timeLeft = Math.max(0, timeLeft - 1);
            label.textContent = timeLeft;
            const pct = (timeLeft / this.timer.total) * 100;
            bar.style.width = `${pct}%`;

            if (timeLeft <= 10) {
                bar.style.backgroundColor = 'var(--error-color)';
            } else if (timeLeft <= 20) {
                bar.style.backgroundColor = 'var(--warning-color)';
            }

            if (timeLeft <= 0) {
                clearInterval(this.timer.interval);
                this.showToast('انتهى الوقت!', 'error');
                this.handleTimeout();
            }
        };

        update();
        this.timer.interval = setInterval(update, 1000);
    },

    handleTimeout: function () {
        const anyWrongBtn = this.dom.optionsGrid.querySelector('.option-btn:not([data-correct="true"])');
        this.checkAnswer(anyWrongBtn || null);
    },

    updateScore: function (newScore, isReset = false) {
        this.gameState.currentScore = Math.max(0, newScore);
        this.dom.scoreDisplay.textContent = this.formatNumber(this.gameState.currentScore);
        this.updateGameStatsUI();

        if (!isReset) {
            this.dom.scoreDisplay.style.transform = 'scale(1.1)';
            setTimeout(() => {
                this.dom.scoreDisplay.style.transform = 'scale(1)';
            }, 200);
        }
    },

    updateGameStatsUI: function () {
        const wrongEl = this.getEl('#wrongAnswersCount');
        const skipEl = this.getEl('#skipCount');
        const skipCostEl = this.getEl('#skipCost');

        if (wrongEl) wrongEl.textContent = `${this.gameState.wrongAnswers} / ${this.config.MAX_WRONG_ANSWERS}`;
        if (skipEl) skipEl.textContent = this.gameState.skips;
        if (skipCostEl) skipCostEl.textContent = '(مجانية)';

        const isImpossible = this.config.LEVELS[this.gameState.level]?.name === 'impossible';
        this.getAllEl('.helper-btn').forEach(btn => {
            const type = btn.dataset.type;
            if (isImpossible) {
                btn.disabled = true;
                btn.title = 'غير متاح في المستوى المستحيل';
                return;
            }
            if (type === 'skipQuestion') btn.disabled = false;
            else btn.disabled = this.gameState.helpersUsed[type] === true;
        });
    },

    calculateFinalStats: function (completedAll) {
        const totalTimeSeconds = (new Date() - this.gameState.startTime) / 1000;
        const currentLevelLabel = this.config.LEVELS[Math.min(this.gameState.level, this.config.LEVELS.length - 1)].label;

        const corr = this.gameState.correctAnswers;
        const wrong = this.gameState.wrongAnswers;
        const skips = this.gameState.skips;

        const denom = corr + wrong + (this.config.SKIP_WEIGHT * skips);
        const accuracy = denom > 0 ? parseFloat(((corr / denom) * 100).toFixed(1)) : 0.0;

        const answeredCount = (corr + wrong) || 1;
        const avgTime = parseFloat((totalTimeSeconds / answeredCount).toFixed(1));

        return {
            name: this.gameState.name,
            player_id: this.gameState.playerId,
            device_id: this.gameState.deviceId,
            session_id: this.gameState.sessionId,
            avatar: this.gameState.avatar,
            correct_answers: corr,
            wrong_answers: wrong,
            skips: skips,
            score: this.gameState.currentScore,
            total_time: totalTimeSeconds,
            level: currentLevelLabel,
            accuracy,
            avg_time: avgTime,
            performance_rating: this.getPerformanceRating(accuracy),
            completed_all: completedAll,
            used_fifty_fifty: this.gameState.helpersUsed.fiftyFifty,
            used_freeze_time: this.gameState.helpersUsed.freezeTime,
            performance_metrics: this.performanceMetrics
        };
    },

    endGame: async function (completedAllLevels = false) {
        this.clearAllTimers();
        this.hideModal('confirmExit');

        const baseStats = this.calculateFinalStats(completedAllLevels);

        try {
            const perf = await this.ratePerformance(baseStats);
            baseStats.performance_rating = perf.label;
            baseStats.performance_score = perf.score;
        } catch (_) {
            const acc = Number(baseStats.accuracy || 0);
            baseStats.performance_rating =
                (acc >= 90) ? 'ممتاز 🏆' :
                    (acc >= 75) ? 'جيد جدًا ⭐' :
                        (acc >= 60) ? 'جيد 👍' :
                            (acc >= 40) ? 'مقبول 👌' : 'يحتاج إلى تحسين 📈';
        }

        this.displayFinalStats(baseStats);
        completedAllLevels ? this.playSound('win') : this.playSound('loss');
        this.showScreen('end');

        this.setCooldown(this.config.COOLDOWN_SECONDS);
        this.startRetryCountdownUI();

        this.saveResultsToSupabase(baseStats).then((res) => {
            if (!res?.error && res?.attemptNumber) {
                baseStats.attempt_number = res.attemptNumber;
                this.gameState.attemptNumber = res.attemptNumber;
                const el = this.getEl('#finalAttemptNumber');
                if (el) el.textContent = String(res.attemptNumber);
                this.playSound('coin');
                this.showToast('تم حفظ نتيجتك!', 'success');
            } else if (res?.error) {
                this.showToast('تعذّر حفظ النتيجة — سنحاول لاحقًا.', 'error');
            }
        }).catch(() => { });

        setTimeout(() => { this.cleanupSession({ keepEndScreen: true }); }, 800);
    },

    playAgainGuarded: async function (btn) {
        const remain = this.getCooldownRemaining();
        if (remain > 0) {
            this.updateRetryCountdownUI(remain);
            this.showToast(`⏳ يمكنك المحاولة بعد ${remain} ثانية.`, 'info');
            return;
        }
        await this.cleanupSession();
        this.currentSessionId = this.generateSessionId();

        if (this._endCountdownInterval) {
            clearInterval(this._endCountdownInterval);
            this._endCountdownInterval = null;
        }
        window.location.reload();
    },

    startRetryCountdownUI: function () {
        const btn = this.getEl('#playAgainBtn') || this.getEl('#endScreen [data-action="playAgain"]');
        const label = this.dom.retryCountdown || this.getEl('#retryCountdown');
        if (!btn) return;

        const originalText = btn.dataset.originalText || btn.textContent || 'لعب مرة أخرى';
        btn.dataset.originalText = originalText;

        const applyState = () => {
            const r = this.getCooldownRemaining();
            if (r > 0) {
                btn.disabled = true;
                btn.setAttribute('aria-busy', 'true');
                btn.textContent = `🔒 يمكنك اللعب مجددًا بعد ${r} ثانية`;
                if (label) { label.textContent = r; label.style.display = ''; }
            } else {
                btn.disabled = false;
                btn.removeAttribute('aria-busy');
                btn.textContent = originalText;
                if (label) { label.textContent = '0'; label.style.display = ''; }
                if (this._endCountdownInterval) {
                    clearInterval(this._endCountdownInterval);
                    this._endCountdownInterval = null;
                }
            }
        };

        applyState();
        const intervalId = setInterval(applyState, 1000);
        this._endCountdownInterval = intervalId;
        this.cleanupQueue.push({ type: 'interval', id: intervalId, keep: true });
    },

    updateRetryCountdownUI: function (remain) {
        const btn = this.getEl('#playAgainBtn') || this.getEl('#endScreen [data-action="playAgain"]');
        const label = this.dom.retryCountdown || this.getEl('#retryCountdown');
        if (!btn) return;

        const originalText = btn.dataset.originalText || btn.textContent || 'لعب مرة أخرى';
        btn.dataset.originalText = originalText;

        if (remain > 0) {
            btn.disabled = true;
            btn.setAttribute('aria-busy', 'true');
            btn.textContent = `🔒 يمكنك اللعب مجددًا بعد ${remain} ثانية`;
            if (label) { label.textContent = remain; label.style.display = ''; }
        } else {
            btn.disabled = false;
            btn.removeAttribute('aria-busy');
            btn.textContent = originalText;
            if (label) { label.textContent = '0'; label.style.display = ''; }
        }
    },

    startFromHomeGuarded: async function (btn) {
        const remain = this.getCooldownRemaining();
        if (remain > 0) {
            this.updateStartCooldownUI(remain);
            this.showToast(`⏳ يمكنك البدء بعد ${remain} ثانية.`, 'info');
            return;
        }
        this.showScreen('avatar');
    },

    startStartCooldownUI: function () {
        const btn = this.getEl('#startBtn');
        if (!btn) return;

        const originalText = btn.dataset.originalText || btn.textContent || 'ابدأ اللعب';
        btn.dataset.originalText = originalText;

        const applyState = () => {
            const r = this.getCooldownRemaining();
            if (r > 0) {
                btn.disabled = true;
                btn.setAttribute('aria-busy', 'true');
                btn.textContent = `🔒 يمكنك البدء بعد ${r} ثانية`;
            } else {
                btn.disabled = false;
                btn.removeAttribute('aria-busy');
                btn.textContent = originalText;
            }
        };

        applyState();
        const intervalId = setInterval(applyState, 1000);
        this.cleanupQueue.push({ type: 'interval', id: intervalId });
    },

    updateStartCooldownUI: function (remain) {
        const btn = this.getEl('#startBtn');
        if (!btn) return;
        const originalText = btn.dataset.originalText || btn.textContent || 'ابدأ اللعب';
        btn.dataset.originalText = originalText;

        if (remain > 0) {
            btn.disabled = true;
            btn.setAttribute('aria-busy', 'true');
            btn.textContent = `🔒 يمكنك البدء بعد ${remain} ثانية`;
        } else {
            btn.disabled = false;
            btn.removeAttribute('aria-busy');
            btn.textContent = originalText;
        }
    },

    async cleanupSession(opts = {}) {
        const { keepEndScreen = false } = opts;
        this.clearAllTimers();
        this.abortPendingRequests();
        this.removeTemporaryListeners();
        this.clearSessionStorage();
        this.resetGameState();
        this.resetUI(keepEndScreen);
        await this.processCleanupQueue();
    },

    clearAllTimers: function () {
        if (this.timer.interval) {
            clearInterval(this.timer.interval);
            this.timer.interval = null;
        }

        this.cleanupQueue.forEach(i => {
            if (i.type === 'timeout') clearTimeout(i.id);
            else if (i.type === 'interval') {
                if (i.keep === true) return;
                clearInterval(i.id);
            }
        });

        this.cleanupQueue = this.cleanupQueue.filter(i => i.keep === true);
    },

    abortPendingRequests() {
        this.pendingRequests.forEach(controller => {
            if (!controller) return;
            if (controller.__skipAbortOnCleanup) return;
            if (!controller.signal.aborted) controller.abort();
        });
        this.pendingRequests.clear();
    },

    removeTemporaryListeners: function () {
        this.cleanupQueue.forEach(i => {
            if (i.type === 'listener' && i.element && i.handler) {
                i.element.removeEventListener(i.event, i.handler);
            }
        });
    },

    clearSessionStorage: function () {
        try {
            const keysToRemove = [];
            for (let i = 0; i < sessionStorage.length; i++) {
                const key = sessionStorage.key(i);
                if (key && key.startsWith('quiz_')) keysToRemove.push(key);
            }
            keysToRemove.forEach(k => sessionStorage.removeItem(k));

            ['currentLevel', 'currentIndex', 'shuffledQuestions', 'activeLifelines', 'tempScore', 'tempTime', 'attemptDraft']
                .forEach(k => localStorage.removeItem(k));
        } catch (e) {
            console.warn('Failed to clear session storage:', e);
        }
    },

    resetGameState: function () {
        this.gameState = {
            name: this.gameState.name || '',
            avatar: this.gameState.avatar || '',
            playerId: this.gameState.playerId || '',
            deviceId: this.getOrSetDeviceId(),
            sessionId: this.generateSessionId()
        };
        this.timer = { interval: null, isFrozen: false, total: 0 };
        this.answerSubmitted = false;
        this.performanceMetrics = {
            startTime: 0,
            questionsAnswered: 0,
            totalTimeSpent: 0
        };
    },

    resetUI: function (keepEndScreen = false) {
        this.getAllEl('.level-indicator').forEach(ind => ind.classList.remove('active', 'completed'));
        this.getEl('#currentScore').textContent = '100';
        this.getEl('#wrongAnswersCount').textContent = '0 / 3';
        this.getEl('#skipCount').textContent = '0';
        Object.values(this.dom.screens).forEach(s => s?.classList?.remove('active'));
        const target = keepEndScreen ? this.dom.screens.end : this.dom.screens.start;
        target?.classList?.add('active');
    },

    async processCleanupQueue() {
        this.cleanupQueue.forEach(item => {
            if (item.type === 'url' && item.value) {
                try {
                    URL.revokeObjectURL(item.value);
                } catch (e) { }
            }
        });

        const ps = this.cleanupQueue.filter(i => i.promise).map(i => i.promise.catch(() => { }));
        await Promise.allSettled(ps);
        this.cleanupQueue = this.cleanupQueue.filter(i => i.keep === true);
    },

    handleNameConfirmation: function () {
        if (this.dom.confirmNameBtn?.disabled) return;
        this.setupInitialGameState();
        this.startGameFlow(0);
    },

    validateNameInput: function () {
        const name = (this.dom.nameInput?.value || '').trim();
        const isValid = name.length >= 3 && name.length <= 15;
        this.dom.nameError.textContent = isValid ? '' : 'يجب أن يتراوح طول الاسم بين ٣ - ١٥ حرفًا';
        this.dom.nameError.classList.toggle('show', !isValid);
        this.dom.confirmNameBtn.disabled = !isValid;
    },

    postInstructionsStartGuarded: async function (targetBtn) {
        const remain = this.getCooldownRemaining();
        if (remain > 0) {
            this.showToast(`⏳ انتظر ${remain} ثانية قبل المحاولة التالية.`, 'info');
            this.updateRetryCountdownUI(remain);
            return;
        }
        await this.cleanupSession();
        this.setupInitialGameState();
        this.startGameFlow(0);
    },

    useHelper: function (btn) {
        const type = btn.dataset.type;
        const isSkip = type === 'skipQuestion';
        const isImpossible = this.config.LEVELS[this.gameState.level]?.name === 'impossible';
        if (isImpossible) {
            this.showToast('المساعدات غير متاحة في المستوى المستحيل.', 'error');
            return;
        }

        const cost = isSkip ? 0 : this.config.HELPER_COSTS[type];
        if (!isSkip && this.gameState.helpersUsed[type]) {
            this.showToast('هذه المساعدة استُخدمت بالفعل في هذا المستوى.', 'error');
            return;
        }

        if (cost > 0) {
            if (this.gameState.currentScore < cost) {
                this.showToast('نقاطك غير كافية!', 'error');
                return;
            }
            this.updateScore(this.gameState.currentScore - cost);
            this.showToast(`تم استخدام المساعدة! -${cost} نقطة`, 'info');
        } else if (isSkip) {
            this.showToast('تم تخطي السؤال.', 'info');
        }

        if (isSkip) {
            clearInterval(this.timer.interval);
            this.gameState.skips++;
            this.gameState.questionIndex++;
            this.updateGameStatsUI();
            this.fetchQuestion();
            return;
        }

        this.gameState.helpersUsed[type] = true;
        this.updateGameStatsUI();

        if (type === 'fiftyFifty') {
            const wrong = this.getAllEl('.option-btn:not([data-correct="true"])');
            this.shuffleArray(Array.from(wrong)).slice(0, 2).forEach(b => b.classList.add('hidden'));
        } else if (type === 'freezeTime') {
            this.timer.isFrozen = true;
            this.getEl('.timer-bar').classList.add('frozen');
            setTimeout(() => {
                this.timer.isFrozen = false;
                this.getEl('.timer-bar').classList.remove('frozen');
            }, 10000);
        }
    },

    setupGameUI: function () {
        this.getEl('#playerAvatar').src = this.gameState.avatar || '';
        this.getEl('#playerName').textContent = this.gameState.name || '';
        this.getEl('#playerId').textContent = this.gameState.playerId || '';
    },

    displayFinalStats: function (stats) {
        this.getEl('#finalName').textContent = stats.name;
        this.getEl('#finalId').textContent = stats.player_id;
        this.getEl('#finalAttemptNumber').textContent = stats.attempt_number || '--';
        this.getEl('#finalCorrect').textContent = stats.correct_answers;
        this.getEl('#finalWrong').textContent = stats.wrong_answers;
        this.getEl('#finalSkips').textContent = stats.skips;
        this.getEl('#finalScore').textContent = this.formatNumber(stats.score);
        this.getEl('#totalTime').textContent = this.formatTime(stats.total_time);
        this.getEl('#finalLevel').textContent = stats.level;
        this.getEl('#finalAccuracy').textContent = `${stats.accuracy}%`;
        this.getEl('#finalAvgTime').textContent = `${this.formatTime(stats.avg_time)}`;
        this.getEl('#performanceText').textContent = stats.performance_rating;
    },

    getPerformanceRating: function (accuracy) {
        if (accuracy >= 90) return 'ممتاز 🏆';
        if (accuracy >= 75) return 'جيد جدًا ⭐';
        if (accuracy >= 60) return 'جيد 👍';
        if (accuracy >= 40) return 'مقبول 👌';
        return 'يحتاج تحسين 📈';
    },

    formatTime: function (totalSeconds) {
        const total = Math.floor(Number(totalSeconds) || 0);
        const minutes = Math.floor(total / 60);
        const seconds = total % 60;
        return `${minutes}:${seconds.toString().padStart(2, '0')}`;
    },

    formatNumber: function (num) {
        return new Intl.NumberFormat('ar-EG').format(Number(num) || 0);
    },

    normalize: function (s) {
        return String(s || '').trim().toLowerCase();
    },

    resolveQuestionFields: function (q) {
        const text = q.q || q.question || q.text || '';
        const options = Array.isArray(q.options) ? q.options : (Array.isArray(q.choices) ? q.choices : []);
        let correctText = '';

        if (typeof q.correct === 'number' && options[q.correct] !== undefined) {
            correctText = options[q.correct];
        } else if (typeof q.answer === 'string') {
            correctText = q.answer;
        } else if (typeof q.correctAnswer === 'string') {
            correctText = q.correctAnswer;
        } else if (typeof q.correct_option === 'string') {
            correctText = q.correct_option;
        } else if (typeof q.correctIndex === 'number' && options[q.correctIndex] !== undefined) {
            correctText = options[q.correctIndex];
        }

        return { text, options, correctText };
    },

    getLevelQuestions: function (levelName) {
        if (Array.isArray(this.questions)) {
            const arr = this.questions.filter(q =>
                (this.normalize(q.level) === this.normalize(levelName)) ||
                (this.normalize(q.difficulty) === this.normalize(levelName))
            );
            return arr.length ? arr : [...this.questions];
        }

        const direct = this.questions[levelName] ||
            this.questions[levelName + 'Questions'] ||
            this.questions[levelName + '_questions'] ||
            this.questions[levelName + '_list'];

        if (Array.isArray(direct)) return [...direct];
        if (Array.isArray(this.questions.questions)) return [...this.questions.questions];

        const merged = Object.values(this.questions).filter(Array.isArray).flat();
        return merged.length ? merged : [];
    },

    shuffleArray: function (arr) {
        for (let i = arr.length - 1; i > 0; i--) {
            const j = Math.floor(Math.random() * (i + 1));
            [arr[i], arr[j]] = [arr[j], arr[i]];
        }
        return arr;
    },

    normalizeTo100: function (value, min, max) {
        const v = Math.max(min, Math.min(max, Number(value) || 0));
        return Math.round(((max - v) / (max - min)) * 100);
    },

    stdDev: function (arr) {
        if (!arr || arr.length < 2) return 0;
        const mean = arr.reduce((a, b) => a + Number(b || 0), 0) / arr.length;
        const variance = arr.reduce((s, v) => s + Math.pow(Number(v || 0) - mean, 2), 0) / (arr.length - 1);
        return Math.sqrt(variance);
    },

    mapPerformanceLabel: function (score, { completed_all = false, level = '' } = {}) {
        if (completed_all && (level === 'مستحيل' || level === 'impossible')) score = Math.max(score, 80);
        if (score >= 97) return 'احترافي 🧠';
        if (score >= 92) return 'مذهل 🌟';
        if (score >= 85) return 'ممتاز 🏆';
        if (score >= 75) return 'جيد جدًا ⭐';
        if (score >= 62) return 'جيد 👍';
        if (score >= 50) return 'مقبول 👌';
        if (score >= 35) return 'يحتاج إلى تحسين 📈';
        return 'ضعيف 🧩';
    },

    ratePerformance: async function (current) {
        let history = [];

        const histAcc = history.map(h => Number(h.accuracy || 0)).filter(n => n >= 0);
        const histAvg = history.map(h => Number(h.avg_time || 0)).filter(n => n >= 0);
        const histDone = history.filter(h => h.completed_all === true).length;
        const histCount = history.length;

        const accuracy = Number(current.accuracy || 0);
        const avgTime = Number(current.avg_time || 0);
        const totalSec = Number(current.total_time || 0);
        const corr = Number(current.correct_answers || 0);
        const wrong = Number(current.wrong_answers || 0);
        const skips = Number(current.skips || 0);
        const lvlName = (current.level || '').toString();
        const completedAll = !!current.completed_all;

        const accScore = Math.max(0, Math.min(100, accuracy));
        const speedScore = this.normalizeTo100(avgTime, 3, 20);

        let levelBonus = 0;
        if (['medium', 'متوسط'].includes(lvlName)) levelBonus += 10;
        else if (['hard', 'صعب'].includes(lvlName)) levelBonus += 25;
        else if (['impossible', 'مستحيل'].includes(lvlName)) levelBonus += 40;
        if (completedAll) levelBonus += 15;

        const cpm = totalSec > 0 ? corr / (totalSec / 60) : 0;
        const cpmBonus = Math.min(20, Math.round(cpm * 4));
        const penalty = (wrong * 4) + (skips * 2);

        let historyBonus = 0;
        if (histCount > 0) {
            const avgAccHist = histAcc.reduce((a, b) => a + b, 0) / (histAcc.length || 1);
            const avgTimeHist = histAvg.reduce((a, b) => a + b, 0) / (histAvg.length || 1);

            const accDelta = accuracy - avgAccHist;
            if (accDelta >= 10) historyBonus += 8;
            else if (accDelta >= 5) historyBonus += 4;
            else if (accDelta <= -10) historyBonus -= 6;

            const sdAcc = this.stdDev(histAcc);
            if (sdAcc <= 8 && avgAccHist >= 70) historyBonus += 5;

            const doneRate = (histDone / histCount) * 100;
            if (doneRate >= 50) historyBonus += 5;
            else if (doneRate >= 25) historyBonus += 2;

            if (avgTimeHist && avgTime < avgTimeHist - 2) historyBonus += 3;
        }

        let score = (0.45 * accScore) + (0.25 * speedScore) + levelBonus + cpmBonus + historyBonus - penalty;
        score = Math.max(0, Math.min(100, Math.round(score)));
        const label = this.mapPerformanceLabel(score, { completed_all: completedAll, level: lvlName });
        return { score, label, details: { accScore, speedScore, levelBonus, cpmBonus, historyBonus, penalty } };
    }
});

Object.assign(QuizGame.prototype, {
    _tx: {
        timeoutMs: 10000,
        maxRetries: 2,
        queueKey: 'bgQueue:v2',
        busy: new Set(),
    },

    _mkIdemKey(kind, payload) {
        const raw = `${kind}:${JSON.stringify(payload)}:${this.gameState?.sessionId || this.currentSessionId}`;
        return `idem:${this.simpleHash(raw)}`;
    },

    async _postJson(url, body, { timeoutMs = this._tx.timeoutMs, retries = this._tx.maxRetries } = {}) {
        const headers = {
            'Content-Type': 'application/json',
            'x-app-key': this.config.APP_KEY,
        };

        const controller = new AbortController();
        const t = setTimeout(() => { try { controller.abort('timeout'); } catch (_) { } }, timeoutMs);

        const attempt = async () => {
            const res = await fetch(url, {
                method: 'POST',
                headers,
                body: JSON.stringify(body || {}),
                referrerPolicy: 'no-referrer',
                signal: controller.signal
            });

            const text = await res.text().catch(() => '');
            let json = {};
            try { json = text ? JSON.parse(text) : {}; } catch (_) { }

            if (!res.ok) {
                const err = new Error(`HTTP ${res.status}${text ? `: ${text}` : ''}`);
                err.status = res.status;
                err.body = text;
                throw err;
            }
            return json;
        };

        try {
            let lastErr = null;
            for (let i = 0; i <= retries; i++) {
                try { return await attempt(); }
                catch (e) {
                    lastErr = e;
                    const retriable = (e.name === 'AbortError') || !navigator.onLine || (e.status >= 500);
                    if (!retriable || i === retries) throw e;
                    await new Promise(r => setTimeout(r, 400 * (i + 1)));
                }
            }
            throw lastErr || new Error('unknown error');
        } finally {
            clearTimeout(t);
        }
    },

    _queuePush(item) {
        try {
            const list = JSON.parse(localStorage.getItem(this._tx.queueKey) || '[]');
            list.push({ ...item, ts: Date.now() });
            localStorage.setItem(this._tx.queueKey, JSON.stringify(list.slice(-25)));
        } catch (_) { }
    },

    async _queueDrain() {
        let list = [];
        try {
            list = JSON.parse(localStorage.getItem(this._tx.queueKey) || '[]');
        } catch (_) {
            list = [];
        }
        if (!list.length) return;

        const remain = [];
        for (const it of list) {
            try {
                if (it.kind === 'result') { await this.saveResultsToSupabase(it.payload, { skipQueue: true }); }
                else if (it.kind === 'log') { await this.sendClientLog(it.payload.event, it.payload.data, { skipQueue: true }); }
                else if (it.kind === 'report') { await this._sendReport(it.payload, { skipQueue: true }); }
                else remain.push(it);
            } catch (_) { remain.push(it); }
        }
        try {
            localStorage.setItem(this._tx.queueKey, JSON.stringify(remain.slice(-25)));
        } catch (_) { }
    },

    async retryFailedSubmissions() {
        await this._queueDrain();
    },

    _bindOnlineOnce: (() => {
        let bound = false;
        return () => {
            if (bound) return;
            bound = true;
            window.addEventListener('online', () => { this._queueDrain(); });
        };
    })(),

    async saveResultsToSupabase(resultsData, opts = {}) {
        const payload = {
            device_id: resultsData?.device_id || this.getOrSetDeviceId(),
            session_id: resultsData?.session_id || (this.gameState?.sessionId || this.currentSessionId || this.generateSessionId()),
            ...resultsData
        };

        const idem = this._mkIdemKey('result', { session_id: payload.session_id, score: payload.score });
        if (this._tx.busy.has(idem)) return { attemptNumber: null, error: null };
        this._tx.busy.add(idem);

        try {
            const json = await this._postJson(this.config.EDGE_SAVE_URL, payload, { idempotencyKey: idem });
            const attemptNumber = json.attempt_number || json.attemptNumber || null;
            return { attemptNumber, error: null };
        } catch (error) {
            if (!opts.skipQueue) this._queuePush({ kind: 'result', payload });
            return { attemptNumber: null, error: String(error && error.message || error) };
        } finally {
            this._tx.busy.delete(idem);
            this._bindOnlineOnce();
        }
    },

    async sendClientLog(event = 'log', payload = {}, opts = {}) {
        const body = {
            event,
            payload,
            session_id: this.gameState?.sessionId || this.currentSessionId || '',
            device_id: this.gameState?.deviceId || this.getOrSetDeviceId(),
            time: new Date().toISOString()
        };

        const idem = this._mkIdemKey('log', { event, time: body.time, session_id: body.session_id });
        if (this._tx.busy.has(idem)) return { ok: true };
        this._tx.busy.add(idem);

        try {
            await this._postJson(this.config.EDGE_LOG_URL, body, { idempotencyKey: idem, timeoutMs: 6000 });
            return { ok: true };
        } catch (error) {
            if (!opts.skipQueue) this._queuePush({ kind: 'log', payload: { event, data: body } });
            return { ok: false, error: String(error && error.message || error) };
        } finally {
            this._tx.busy.delete(idem);
            this._bindOnlineOnce();
        }
    },

    async _sendReport(payload, opts = {}) {
        const idem = this._mkIdemKey('report', { h: this.simpleHash(JSON.stringify(payload || {})) });
        if (this._tx.busy.has(idem)) return { ok: true };
        this._tx.busy.add(idem);

        try {
            await this._postJson(this.config.EDGE_REPORT_URL, payload, { idempotencyKey: idem });
            return { ok: true };
        } catch (error) {
            if (!opts.skipQueue) this._queuePush({ kind: 'report', payload });
            return { ok: false, error: String(error && error.message || error) };
        } finally {
            this._tx.busy.delete(idem);
            this._bindOnlineOnce();
        }
    },

    handleReportSubmit(event) {
        event.preventDefault();
        const form = event.target;

        const formData = new FormData(form);
        const problemLocation = formData.get('problemLocation');

        const reportData = {
            type: formData.get('problemType'),
            description: String(formData.get('problemDescription') || '').trim(),
            name: this.gameState.name || 'لم يبدأ اللعب',
            player_id: this.gameState.playerId || 'N/A',
            question_text: this.dom.questionText?.textContent || 'لا يوجد'
        };

        if (!reportData.description) {
            this.showToast('رجاءً اكتب وصفًا للمشكلة قبل الإرسال.', 'error');
            return;
        }

        let meta = null;
        if (this.dom.includeAutoDiagnostics?.checked) {
            meta = this.getAutoDiagnostics();
            meta.locationHint = problemLocation;
        }
        const ctx = this.buildQuestionRef();

        this.showToast('يتم إرسال البلاغ…', 'info');
        this.hideModal('advancedReport');

        (async () => {
            try {
                let image_base64 = null;
                const file = this.dom.problemScreenshot?.files?.[0];
                if (file) {
                    image_base64 = await new Promise((resolve) => {
                        const r = new FileReader();
                        r.onload = () => resolve(String(r.result));
                        r.readAsDataURL(file);
                    });
                }

                const payload = {
                    ...reportData,
                    image_base64,
                    meta: {
                        ...(meta || {}),
                        context: ctx,
                        device_id: this.gameState?.deviceId || this.getOrSetDeviceId(),
                        session_id: this.gameState?.sessionId || this.currentSessionId
                    }
                };

                const res = await this._sendReport(payload);
                if (!res.ok) throw new Error(res.error || 'report failed');

                try {
                    form.reset();
                    if (this.dom.reportImagePreview) {
                        this.dom.reportImagePreview.style.display = 'none';
                        this.dom.reportImagePreview.querySelector('img').src = '';
                    }
                    if (this.dom.problemScreenshot) this.dom.problemScreenshot.value = '';
                } catch (_) { }

                setTimeout(() => this.showToast('تم إرسال بلاغك. شكرًا لك!', 'success'), 300);
            } catch (err) {
                console.error('Report error:', err);
                this.showToast('تعذّر إرسال البلاغ الآن. سنحاول لاحقًا تلقائيًا.', 'error');
            }
        })();
    },

    async loadQuestions() {
        try {
            const cacheKey = 'questions_cache';
            const cacheTime = 'questions_cache_time';
            const CACHE_DURATION = 5 * 60 * 1000;

            const cachedTime = localStorage.getItem(cacheTime);
            const now = Date.now();

            if (cachedTime && (now - parseInt(cachedTime)) < CACHE_DURATION) {
                const cachedData = localStorage.getItem(cacheKey);
                if (cachedData) {
                    this.questions = JSON.parse(cachedData);
                    return true;
                }
            }

            const res = await fetch(this.config.QUESTIONS_URL, {
                cache: 'no-cache',
                headers: { 'Content-Type': 'application/json' }
            });
            if (!res.ok) throw new Error(`HTTP ${res.status}`);
            const data = await res.json();

            if (typeof data === 'object' && data !== null) {
                this.questions = data;

                try {
                    localStorage.setItem(cacheKey, JSON.stringify(data));
                    localStorage.setItem(cacheTime, now.toString());
                } catch (e) {
                    console.warn('Failed to cache questions:', e);
                }
                return true;
            }
            throw new Error('Invalid questions data');
        } catch (err) {
            console.error('Failed to load questions:', err);
            this.showToast('خطأ في تحميل الأسئلة', 'error');
            return false;
        }
    },

    async displayLeaderboard() {
        this.showScreen('leaderboard');
        const box = this.dom.leaderboardContent;
        if (box) box.innerHTML = '<div class="spinner"></div>';

        if (!this.lbFirstOpenDone) {
            if (this.dom.lbMode) this.dom.lbMode.value = 'all';
            this.lbFirstOpenDone = true;
        }

        const mode = this.dom.lbMode?.value || 'all';
        if (this.dom.lbAttempt) this.dom.lbAttempt.disabled = (mode !== 'attempt');

        const LB_URL = this.config.EDGE_LEADERBOARD_URL ||
            (this.config.SUPABASE_URL + '/functions/v1/leaderboard');

        try {
            let rows;

            if (mode === 'attempt') {
                await this.updateAttemptsFilter();
                const attemptN = Number(this.dom.lbAttempt?.value || 1);
                rows = await this._postJson(LB_URL, { mode: 'attempt', attempt: attemptN });
            } else {
                rows = await this._postJson(LB_URL, { mode });
                if (mode === 'best') {
                    const seen = new Set();
                    const uniq = [];
                    for (const r of rows || []) {
                        const k = r.device_id || r.deviceId || '';
                        if (!seen.has(k)) { seen.add(k); uniq.push(r); }
                    }
                    rows = uniq;
                }
            }

            this.renderLeaderboard((rows || []).slice(0, 50));
        } catch (e) {
            console.error('Error loading leaderboard:', e);
            if (box) box.innerHTML = '<p>حدث خطأ في تحميل لوحة الصدارة.</p>';
        }
    },

    async updateAttemptsFilter() {
        const LB_URL = this.config.EDGE_LEADERBOARD_URL ||
            (this.config.SUPABASE_URL + '/functions/v1/leaderboard');
        try {
            const { maxAttempt = 1 } = await this._postJson(LB_URL, { mode: 'maxAttempt' });

            if (this.dom.lbAttempt) {
                const prev = this.dom.lbAttempt.value || '';
                this.dom.lbAttempt.innerHTML = '';
                for (let i = 1; i <= maxAttempt; i++) {
                    const opt = document.createElement('option');
                    opt.value = String(i);
                    opt.textContent = `المحاولة ${i}`;
                    this.dom.lbAttempt.appendChild(opt);
                }
                if (prev && Number(prev) >= 1 && Number(prev) <= maxAttempt) {
                    this.dom.lbAttempt.value = String(prev);
                } else {
                    this.dom.lbAttempt.value = String(maxAttempt);
                }
            }
        } catch (e) {
            console.error('Error updating attempts filter:', e);
        }
    },

    renderLeaderboard(players) {
        if (!players.length) {
            this.dom.leaderboardContent.innerHTML = '<p>لوحة الصدارة فارغة حاليًا!</p>';
            return;
        }

        const list = document.createElement('ul');
        list.className = 'leaderboard-list';
        const medals = ['🥇', '🥈', '🥉'];
        let rank = 1;

        const firstImpossibleFinisher = players.find(pl => pl.is_impossible_finisher);

        players.forEach(p => {
            const li = document.createElement('li');
            li.className = 'leaderboard-item';
            let rankDisplay;

            if (p === firstImpossibleFinisher) {
                li.classList.add('impossible-finisher');
                rankDisplay = '🎖️';
            } else {
                if (rank <= 3) {
                    li.classList.add(`rank-${rank}`);
                    rankDisplay = medals[rank - 1];
                } else {
                    rankDisplay = rank;
                }
                rank++;
            }

            li.innerHTML = `
                <span class="leaderboard-rank">${rankDisplay}</span>
                <img src="${p.avatar || ''}" alt="صورة ${p.name || ''}" class="leaderboard-avatar" loading="lazy" style="visibility:${p.avatar ? 'visible' : 'hidden'}">
                <div class="leaderboard-details">
                    <span class="leaderboard-name">${p.name || 'غير معروف'}</span>
                    <span class="leaderboard-score">${this.formatNumber(p.score)}</span>
                </div>
            `;

            li.addEventListener('click', () => this.showPlayerDetails(p));
            list.appendChild(li);
        });

        this.dom.leaderboardContent.innerHTML = '';
        this.dom.leaderboardContent.appendChild(list);
    },

    showPlayerDetails(player) {
        this.getEl('#detailsName').textContent = player.name || 'غير معروف';
        this.getEl('#detailsPlayerId').textContent = player.player_id || 'N/A';
        const avatarEl = this.getEl('#detailsAvatar');
        avatarEl.src = player.avatar || '';
        avatarEl.style.visibility = player.avatar ? 'visible' : 'hidden';

        const score = Number(player.score || 0);
        const level = player.level || 'N/A';
        const correct = Number(player.correct_answers || 0);
        const wrong = Number(player.wrong_answers || 0);
        const timeAll = this.formatTime(player.total_time || 0);
        const avg = this.formatTime(player.avg_time || 0);
        const accNum = Math.max(0, Math.min(100, Math.round(Number(player.accuracy || 0))));
        const skips = Number(player.skips || 0);
        const att = Number(player.attempt_number || 0);
        const perf = player.performance_rating || 'جيد';

        const card = (title, value, extra = '') => `
            <div class="stat-card" style="${extra}">
                <div class="label">${title}</div>
                <div class="value">${value}</div>
            </div>`;

        const twoRows = (k1, v1, k2, v2, extra = '') => `
            <div class="stat-card" style="display:grid;gap:.38rem;${extra}">
                <div style="display:flex;align-items:center;justify-content:space-between;gap:.6rem"><span class="label">${k1}</span><span class="value" style="font-size:1.06rem">${v1}</span></div>
                <div style="display:flex;align-items:center;justify-content:space-between;gap:.6rem"><span class="label">${k2}</span><span class="value" style="font-size:1.06rem">${v2}</span></div>
            </div>`;

        const pos = v => `<span style="color:var(--success-color)">${this.formatNumber(v)}</span>`;
        const neg = v => `<span style="color:var(--error-color)">${this.formatNumber(v)}</span>`;

        const html = `
            <div class="stats-grid">
                ${card('👑 المستوى', level)}
                ${card('⭐ النقاط', `<span class="value score">${this.formatNumber(score)}</span>`)}
                ${twoRows('✅ الصحيحة', pos(correct), '❌ الخاطئة', neg(wrong))}
                ${twoRows('⏱️ الوقت', timeAll, '⏳ المتوسط', `${avg}`)}
                ${card('🔢 المحاولة', this.formatNumber(att))}
                ${card('⏭️ التخطّي', this.formatNumber(skips))}
                ${card('📊 الأداء', perf)}
                <div class="stat-card accuracy">
                    <div class="label" style="margin-bottom:.3rem">🎯 الدقّة</div>
                    <div style="display:grid;place-items:center">
                        <div class="circle-progress" style="--val:${accNum};--bar:${this.getAccuracyBarColor(accNum)};"><span>${accNum}%</span></div>
                    </div>
                </div>
            </div>`;

        this.getEl('#playerDetailsContent').innerHTML = html;
        this.showModal('playerDetails');
    },

    getAccuracyBarColor(pct) {
        const p = Math.max(0, Math.min(100, Number(pct) || 0));
        const hue = Math.round((p / 100) * 120);
        return `hsl(${hue} 70% 45%)`;
    }
});

Object.assign(QuizGame.prototype, {
    populateAvatarGrid() {
        const grid = this.getEl('.avatar-grid');
        if (!grid) return;
        grid.innerHTML = '';

        const uploadBtnHTML = `
            <div class="avatar-upload-btn" title="رفع صورة">
                <span aria-hidden="true">+</span>
                <label for="avatarUploadInput" class="sr-only">رفع صورة</label>
                <input type="file" id="avatarUploadInput" accept="image/*" style="display:none;">
            </div>`;
        grid.insertAdjacentHTML('beforeend', uploadBtnHTML);
        this.getEl('#avatarUploadInput').addEventListener('change', e => this.handleAvatarUpload(e));
        this.getEl('.avatar-upload-btn').addEventListener('click', () => this.getEl('#avatarUploadInput').click());

        const avatarUrls = [
            "###", // ضع رابط الصورة الرمزية 1
            "###", // ضع رابط الصورة الرمزية 2
            "###", // ضع رابط الصورة الرمزية 3
            "###", // ضع رابط الصورة الرمزية 4
            "###", // ضع رابط الصورة الرمزية 5
            "###", // ضع رابط الصورة الرمزية 6
            "###", // ضع رابط الصورة الرمزية 7
            "###"  // ضع رابط الصورة الرمزية 8
        ];

        this.preloadImages(avatarUrls);

        avatarUrls.forEach((url, i) => {
            const img = document.createElement('img');
            img.src = url;
            img.alt = `صورة رمزية ${i + 1}`;
            img.className = 'avatar-option';
            img.loading = 'lazy';
            grid.appendChild(img);
        });
    },

    selectAvatar(element) {
        this.getAllEl('.avatar-option.selected, .avatar-upload-btn.selected').forEach(el => el.classList.remove('selected'));
        element.classList.add('selected');
        this.gameState.avatar = element.src;
        this.dom.confirmAvatarBtn.disabled = false;
    },

    handleAvatarUpload(event) {
        const file = event.target.files[0];
        if (file && file.type.startsWith('image/')) {

            if (file.size > 5 * 1024 * 1024) {
                this.showToast('حجم الصورة كبير جداً. الرجاء اختيار صورة أصغر من 5MB.', 'error');
                return;
            }

            const reader = new FileReader();
            reader.onload = e => {
                this.dom.imageToCrop.src = e.target.result;
                this.showModal('avatarEditor');
                setTimeout(() => {
                    if (this.cropper) this.cropper.destroy();
                    this.cropper = new Cropper(this.dom.imageToCrop, {
                        aspectRatio: 1,
                        viewMode: 1,
                        autoCropArea: 1
                    });
                }, 300);
            };
            reader.readAsDataURL(file);
        } else {
            this.showToast('الرجاء اختيار ملف صورة صالح.', 'error');
        }
    },

    saveCroppedAvatar() {
        if (!this.cropper) return;

        try {
            const croppedUrl = this.cropper.getCroppedCanvas({ width: 256, height: 256 }).toDataURL('image/png');
            let customAvatar = this.getEl('#custom-avatar');
            if (!customAvatar) {
                customAvatar = document.createElement('img');
                customAvatar.id = 'custom-avatar';
                customAvatar.className = 'avatar-option';
                this.getEl('.avatar-upload-btn').after(customAvatar);
            }
            customAvatar.src = croppedUrl;
            this.selectAvatar(customAvatar);
            this.hideModal('avatarEditor');
            this.cleanupAvatarEditor();
        } catch (error) {
            console.error('Error saving cropped avatar:', error);
            this.showToast('حدث خطأ أثناء حفظ الصورة', 'error');
        }
    },

    cleanupAvatarEditor() {
        try {
            if (this.cropper) {
                this.cropper.destroy();
                this.cropper = null;
            }
        } catch (_) { }

        if (this.dom?.imageToCrop) this.dom.imageToCrop.src = '';
        const input = this.getEl('#avatarUploadInput');
        if (input) input.value = '';
    },

    getShareTextForX() {
        const name = this.getEl('#finalName').textContent || '';
        const attempt = this.getEl('#finalAttemptNumber').textContent || '';
        const correct = this.getEl('#finalCorrect').textContent || '0';
        const skips = this.getEl('#finalSkips').textContent || '0';
        const level = this.getEl('#finalLevel').textContent || '';
        const acc = this.getEl('#finalAccuracy').textContent || '0%';
        const avg = this.getEl('#finalAvgTime').textContent || '0:00 / سؤال';
        const perf = this.getEl('#performanceText').textContent || '';

        return [
            '🏆 النتائج النهائية 🏆', '',
            `الاسم: ${name}`,
            `رقم المحاولة: ${attempt}`,
            `الإجابات الصحيحة: ${correct}`,
            `مرات التخطي: ${skips}`,
            `المستوى الذي وصلت إليه: ${level}`,
            `نسبة الدقة: ${acc}`,
            `متوسط وقت الإجابة: ${avg}`,
            `أداؤك: ${perf}`,
            '🎉 تهانينا! لقد أكملت المسابقة بنجاح! 🎉', '',
            '🔗 جرب تحديك أنت أيضًا!', window.location.href
        ].join('\n');
    },

    shareOnX() {
        const text = this.getShareTextForX();
        const url = `https://twitter.com/intent/tweet?text=${encodeURIComponent(text)}`;
        window.open(url, '_blank');
    },

    shareOnInstagram() {
        const text = this.getShareTextForX();
        navigator.clipboard.writeText(text)
            .then(() => this.showToast('تم نسخ النتيجة لمشاركتها!', 'success'))
            .catch(() => this.showToast('فشل نسخ النتيجة.', 'error'));
    },

    getAutoDiagnostics() {
        try {
            const nav = navigator || {};
            const conn = nav.connection || {};
            const perf = performance || {};
            const mem = perf.memory || {};
            const activeScreen = Object.entries(this.dom.screens).find(([, el]) => el.classList.contains('active'))?.[0] || 'unknown';

            return {
                url: location.href,
                userAgent: nav.userAgent || '',
                platform: nav.platform || '',
                language: nav.language || '',
                viewport: { w: window.innerWidth, h: window.innerHeight, dpr: window.devicePixelRatio || 1 },
                connection: { type: conn.effectiveType || '', downlink: conn.downlink || '', rtt: conn.rtt || '' },
                performance: {
                    memory: {
                        jsHeapSizeLimit: mem.jsHeapSizeLimit || null,
                        totalJSHeapSize: mem.totalJSHeapSize || null,
                        usedJSHeapSize: mem.usedJSHeapSize || null
                    },
                    timingNow: perf.now ? Math.round(perf.now()) : null
                },
                appState: {
                    screen: activeScreen,
                    level: this.config.LEVELS[this.gameState?.level || 0]?.name || null,
                    questionIndex: this.gameState?.questionIndex ?? null,
                    score: this.gameState?.currentScore ?? null
                },
                recentErrors: this.recentErrors || []
            };
        } catch (e) {
            return { error: String(e) };
        }
    },

    buildQuestionRef() {
        const levelObj = this.config.LEVELS[this.gameState.level] || {};
        const levelName = levelObj.name || '';
        const levelLabel = levelObj.label || '';
        const qIndex1 = (this.gameState.questionIndex ?? 0) + 1;
        const total = (this.gameState.shuffledQuestions || []).length;
        const qText = (this.dom.questionText?.textContent || '').trim();
        const options = [...this.getAllEl('.option-btn')].map(b => (b.textContent || '').trim());
        const hash = this.simpleHash(`${levelName}|${qIndex1}|${qText}|${options.join('|')}`);

        return {
            level_name: levelName,
            level_label: levelLabel,
            question_index: qIndex1,
            total_questions: total,
            question_text: qText,
            options,
            ref: `${levelName}:${qIndex1}:${hash.slice(0, 6)}`
        };
    },

    simpleHash(s) {
        let h = 0;
        for (let i = 0; i < s.length; i++) {
            h = ((h << 5) - h) + s.charCodeAt(i);
            h |= 0;
        }
        return String(Math.abs(h));
    },

    getOrSetDeviceId() {
        let deviceId;
        try {
            deviceId = localStorage.getItem('quizGameDeviceId');
        } catch (_) { }

        if (!deviceId) {
            deviceId = 'D' + Date.now().toString(36) + Math.random().toString(36).substring(2, 11).toUpperCase();
            try {
                localStorage.setItem('quizGameDeviceId', deviceId);
            } catch (_) { }
        }
        return deviceId;
    },

    getCooldownKey() {
        const device = this.gameState?.deviceId || this.getOrSetDeviceId();
        return `quizCooldown:${device}`;
    },

    setCooldown(seconds = this.config.COOLDOWN_SECONDS) {
        const until = Date.now() + (Math.max(1, seconds) * 1000);
        try {
            localStorage.setItem(this.getCooldownKey(), String(until));
        } catch (_) { }
    },

    getCooldownRemaining() {
        try {
            const v = Number(localStorage.getItem(this.getCooldownKey()) || 0);
            const diff = Math.ceil((v - Date.now()) / 1000);
            return Math.max(0, diff);
        } catch (_) {
            return 0;
        }
    },

    clearCooldown() {
        try {
            localStorage.removeItem(this.getCooldownKey());
        } catch (_) { }
    }
});

document.addEventListener('DOMContentLoaded', () => {
    const savedTheme = localStorage.getItem('theme') || 'dark';
    document.body.dataset.theme = savedTheme;
    const toggleBtn = document.querySelector('.theme-toggle-btn');
    if (toggleBtn) toggleBtn.textContent = (savedTheme === 'dark') ? ICON_SUN : ICON_MOON;
    new QuizGame();

    // نظام المساعدة
    (function () {
        const cards = [
            {
                title: 'النقاط', icon: '⚖️', html: `
    <div class="help-card">
    <h4><span class="icon">⚖️</span><span>النقاط</span></h4>
    <p>كل إجابة صحيحة تمنحك <b>+100</b> نقطة.</p>
    <p>الإجابة الخاطئة تخصم <b>100</b> نقطة من رصيدك.</p>
    <p>حافظ على نقاطك مرتفعة قبل انتهاء فرص الأخطاء.</p>
    </div>
    `},
            {
                title: 'المساعدات', icon: '🛠️', html: `
    <div class="help-card">
    <h4><span class="icon">🛠️</span><span>المساعدات</span></h4>
    <ul>
    <li>التخطي <b>مجاني دائمًا</b>.</li>
    <li><b>50:50</b> يحذف خيارين خاطئين.</li>
    <li><b>تجميد الوقت</b> يوقف المؤقت 10 ثوانٍ.</li>
    <li>تُعاد المساعدات مع بداية أول <b>ثلاثة مستويات</b> جديدة.</li>
    </ul>
    </div>
    `},
            {
                title: 'المستويات', icon: '🎯', html: `
    <div class="help-card">
    <h4><span class="icon">🎯</span><span>المستويات</span></h4>
    <p>تدرّج الصعوبة: <b>سهل</b> ثم <b>متوسط</b> ثم <b>صعب</b> ثم <b>مستحيل</b>.</p>
    <p>أكمل كل مستوى للوصول إلى النهائي.</p>
    </div>
    `},
            {
                title: 'مساعدة التخطي', icon: '⏭️', html: `
    <div class="help-card">
    <h4><span class="icon">⏭️</span><span>مساعدة التخطي</span></h4>
    <p>يمكنك استخدام ميزة <b>التخطي</b> بحرية تامة خلال أول <b>ثلاث مستويات</b>.</p>
    <p>لا توجد حدود لعدد مرات استخدامها في تلك المراحل.</p>
    <p>استفد منها لتجاوز الأسئلة الصعبة بسرعة.</p>
    </div>
    `},
            {
                title: 'المستوى المستحيل', icon: '🚫', html: `
    <div class="help-card">
    <h4><span class="icon">🚫</span><span>المستوى المستحيل</span></h4>
    <p>في هذا المستوى لا تتوفر أي نوع من المساعدات.</p>
    <p>الاعتماد الكامل على مهارتك وسرعة تفكيرك.</p>
    <p>أكمله لتحصل على لقب البطل الحقيقي.</p>
    </div>
    `},
            {
                title: 'مشاركة النتائج', icon: '📢', html: `
    <div class="help-card">
    <h4><span class="icon">📢</span><span>مشاركة النتائج</span></h4>
    <p>يمكنك مشاركة نتيجتك مباشرة عبر <b>منصة إكس</b>.</p>
    <p>اضغط على أيقونة إكس في شاشة النتائج.</p>
    <p>سيُجهّز لك منشور تلقائي جاهز للنشر.</p>
    </div>
    `},
            {
                title: 'لوحة الصدارة', icon: '🏆', html: `
    <div class="help-card">
    <h4><span class="icon">🏆</span><span>لوحة الصدارة</span></h4>
    <p>يمكنك الاطّلاع على نتائجك ونتائج اللاعبين الآخرين.</p>
    <p>اضغط على أي اسم في القائمة لتفاصيل أدائه.</p>
    <p>تعرف على ترتيبك وتقدمك في المنافسة.</p>
    </div>
    `},
            {
                title: 'تصفية النتائج', icon: '🎚️', html: `
    <div class="help-card">
    <h4><span class="icon">🎚️</span><span>تصفية النتائج</span></h4>
    <p>استخدم فلتر النتائج في لوحة الصدارة.</p>
    <p>يمكنك عرض النتائج حسب <b>الأفضل</b> أو <b>الأعلى دقة</b> أو <b>الأسرع</b>.</p>
    <p>كما يمكنك تصفيتها حسب عدد المحاولات.</p>
    </div>
    `},
            {
                title: 'الدعم', icon: '📩', html: `
    <div class="help-card">
    <h4><span class="icon">📩</span><span>الدعم</span></h4>
    <p>للاقتراحات أو الإبلاغ عن مشكلة:</p>
    <ul>
    <li><a href="###" target="_blank" rel="noopener noreferrer">إكس</a></li> <!-- ضع رابط إكس -->
    <li><a href="###" target="_blank" rel="noopener noreferrer">إنستغرام</a></li> <!-- ضع رابط إنستغرام -->
    </ul>
    </div>
    `}
        ];
        const $ = (s, r = document) => r.querySelector(s);
        const fab = $('#helpFab');
        const drawer = $('#helpDrawer');
        const body = $('#helpBody');
        const backdrop = $('#helpBackdrop');
        const progress = $('#helpProgress');
        const btnPrev = $('[data-help="prev"]', drawer);
        const btnNext = $('[data-help="next"]', drawer);
        const btnClose = $('[data-help="close"]', drawer);
        if (!fab || !drawer || !body || !progress) { return; }
        let i = Math.min(Math.max(parseInt(localStorage.getItem('help.index') || '0', 10), 0), cards.length - 1);
        function render() {
            body.innerHTML = cards[i].html;
            progress.textContent = (i + 1) + '/' + cards.length;
            btnPrev.disabled = (i === 0);
            btnNext.disabled = (i === cards.length - 1);
            localStorage.setItem('help.index', String(i));
        }
        function open() { drawer.classList.add('open'); drawer.setAttribute('aria-hidden', 'false'); backdrop.hidden = false; fab.setAttribute('aria-expanded', 'true'); setTimeout(() => drawer.focus(), 0) }
        function close() { drawer.classList.remove('open'); drawer.setAttribute('aria-hidden', 'true'); backdrop.hidden = true; fab.setAttribute('aria-expanded', 'false'); fab.focus() }
        fab.addEventListener?.('click', open);
        fab.addEventListener?.('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); open() } });
        btnClose?.addEventListener('click', close);
        backdrop?.addEventListener('click', close);
        document.addEventListener('keydown', (e) => { if (e.key === 'Escape') close() });
        btnPrev?.addEventListener('click', () => { if (i > 0) { i--; render() } });
        btnNext?.addEventListener('click', () => { if (i < cards.length - 1) { i++; render() } });
        render();
    })();
});
