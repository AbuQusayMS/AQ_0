const ICON_SUN = '\u2600\uFE0F';
const ICON_MOON = '\uD83C\uDF19';

class QuizGame {
    constructor() {
        this.config = {
            SUPABASE_URL: 'https://ckbphyndplaihlfdypyi.supabase.co',
            SUPABASE_KEY: 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImNrYnBoeW5kcGxhaWhsZmR5cHlpIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NjA1MjI3MjQsImV4cCI6MjA3NjA5ODcyNH0.waA1ZU5pU3n-d7VHn18MQ8J7qVPT9mz1udKUeEjcydI',
            EDGE_SAVE_URL: 'https://ckbphyndplaihlfdypyi.supabase.co/functions/v1/saveResult',
            EDGE_LEADERBOARD_URL: 'https://ckbphyndplaihlfdypyi.supabase.co/functions/v1/leaderboard',
            APP_KEY: 'MS_AbuQusay',
            QUESTIONS_URL: 'https://abuqusayms.github.io/MS_AbuQusay/questions.json',

            QUESTION_TIME: 80,
            MAX_WRONG_ANSWERS: Infinity, // غير محدود
            STARTING_SCORE: 100,

            LEVELS: [
                { name: 'easy',       label: 'سهل' },
                { name: 'medium',     label: 'متوسط' },
                { name: 'hard',       label: 'صعب' },
                { name: 'impossible', label: 'مستحيل' }
            ],

            HELPER_COSTS: { fiftyFifty: 100, freezeTime: 100, skipQuestionBase: 0, skipQuestionIncrement: 0 },
            SKIP_WEIGHT: 0.7,

            CLICK_DEBOUNCE_MS: 600,
            COOLDOWN_SECONDS: 30,
            REQ_TIMEOUT_MS: 10000
        };

        // حالة اللعبة
        this.questions = {};
        this.gameState = {};
        this.timer = { interval: null, isFrozen: false, total: 0 };

        // مراجع DOM
        this.dom = {};

        // وحدات
        this.cropper = null;
        this.leaderboardSubscription = null;

        // سجلات وأصوات
        this.recentErrors = [];
        this.audioPools = {};
        this._audioReady = false;

        // معرفات وجلسة
        this.currentSessionId = this.generateSessionId();
        this.lastActionAt = new Map();

        // طوابير وتنظيف
        this.cleanupQueue = [];
        this.pendingRequests = new Set();

        // كاشات
        this.imageCache = new Map();
        this.leaderboardCache = new Map();

        // حالات أخرى
        this.answerSubmitted = false;
        this.lbFirstOpenDone = false;
        this._lbTicker = null;            // مؤشر عداد "آخر تحديث"
        this._endCountdownInterval = null;

        // الأداء
        this.performanceMetrics = { startTime: 0, questionsAnswered: 0, totalTimeSpent: 0 };

        // تهيئة عامة
        this.setupErrorHandling();
        this.setupBackButtonHandler();
        this.init();
    }

    /* ------------------------------ أدوات DOM ------------------------------ */
    getEl(selector, parent = document) { return parent.querySelector(selector); }
    getAllEl(selector, parent = document) { return Array.from(parent.querySelectorAll(selector)); }

    cacheDomElements() {
        const byId = (id) => document.getElementById(id);
        this.dom = {
            screens: {
                loader: byId('loader'),
                start: byId('startScreen'),
                avatar: byId('avatarScreen'),
                nameEntry: byId('nameEntryScreen'),
                game: byId('gameContainer'),
                levelComplete: byId('levelCompleteScreen'),
                end: byId('endScreen'),
                leaderboard: byId('leaderboardScreen')
            },
            modals: {
                confirmExit: byId('confirmExitModal'),
                avatarEditor: byId('avatarEditorModal'),
                playerDetails: byId('playerDetailsModal')
            },
            nameInput: byId('nameInput'),
            nameError: byId('nameError'),
            confirmNameBtn: byId('confirmNameBtn'),
            confirmAvatarBtn: byId('confirmAvatarBtn'),
            imageToCrop: byId('image-to-crop'),
            leaderboardContent: byId('leaderboardContent'),
            questionText: byId('questionText'),
            optionsGrid: this.getEl('.options-grid'),
            scoreDisplay: byId('currentScore'),
            lbMode: byId('lbMode'),
            lbAttempt: byId('lbAttempt'),
            retryHint: byId('retryHint'),
            retryCountdown: byId('retryCountdown'),
            startBtn: byId('startBtn')
        };
    }

    bindEventListeners() {
        document.body.addEventListener('click', (e) => {
            const target = e.target.closest('[data-action]');
            if (!target) return;
            const action = target.dataset.action;

            const handlers = {
                showAvatarScreen:     () => this.startFromHomeGuarded(target),
                showNameEntryScreen:  () => this.showScreen('nameEntry'),
                confirmName:          () => this.handleNameConfirmation(),
                showLeaderboard:      () => this.displayLeaderboard(),
                showStartScreen:      () => this.showScreen('start'),
                toggleTheme:          () => this.toggleTheme(),
                showConfirmExitModal: () => this.showModal('confirmExit'),
                closeModal:           () => {
                    const id = target.dataset.modalId || target.dataset.modalKey;
                    if (id === 'avatarEditor' || id === 'avatarEditorModal') this.cleanupAvatarEditor();
                    this.hideModal(id);
                },
                endGame:              () => this.endGame(),
                nextLevel:            () => this.nextLevel(),
                playAgain:            () => this.playAgainGuarded(target),
                shareOnX:             () => this.shareOnX(),
                shareOnInstagram:     () => this.shareOnInstagram(),
                saveCroppedAvatar:    () => this.saveCroppedAvatar()
            };

            if (!this.guardAction(target, action)) return;
            if (handlers[action]) {
                this.playSound('click');
                handlers[action]();
            }
        });

        this.dom.nameInput?.addEventListener('input', () => this.validateNameInput());
        this.dom.nameInput?.addEventListener('keypress', (e) => { if (e.key === 'Enter') this.handleNameConfirmation(); });

        this.dom.optionsGrid?.addEventListener('click', (e) => {
            const btn = e.target.closest('.option-btn');
            if (!btn) return;
            this.getAllEl('.option-btn').forEach(b => b.classList.add('disabled'));
            this.checkAnswer(btn);
        });

        const helpersEl = this.getEl('.helpers');
        helpersEl?.addEventListener('click', (e) => {
            const btn = e.target.closest('.helper-btn');
            if (btn) this.useHelper(btn);
        });

        const avatarGrid = this.getEl('.avatar-grid');
        avatarGrid?.addEventListener('click', (e) => {
            if (e.target.matches('.avatar-option')) this.selectAvatar(e.target);
        });

        document.querySelectorAll('.modal').forEach(modal => {
            modal.addEventListener('click', (e) => {
                if (e.target.classList.contains('modal')) {
                    const modalId = modal.id;
                    if (modalId === 'avatarEditorModal') this.cleanupAvatarEditor();
                    modal.classList.remove('active');
                }
            });
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

        window.addEventListener('online',  () => this.handleOnlineStatus());
        window.addEventListener('offline', () => this.handleOfflineStatus());
    }

    /* ------------------------------ تهيئة عامة ------------------------------ */
    async init() {
        this.cacheDomElements();
        this.bindEventListeners();
        this.setupPaletteSelector();
        this.populateAvatarGrid();
        await this.preloadAudio();

        const ok = await this.loadQuestions();
        if (ok) {
            this.showScreen('start');
        } else {
            const lt = this.getEl('#loaderText');
            if (lt) lt.textContent = 'حدث خطأ في تحميل الأسئلة. الرجاء تحديث الصفحة.';
        }
        this.dom.screens.loader?.classList.remove('active');
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
            console.error('Unhandled Error:', error.message, error.source, error.line);
        });

        window.addEventListener('unhandledrejection', (ev) => {
            const error = {
                type: 'unhandledrejection',
                reason: String(ev.reason || ''),
                time: new Date().toISOString()
            };
            this.recentErrors.push(error);
            this.recentErrors = this.recentErrors.slice(-10);
            console.error('Unhandled Rejection:', error.reason);
        });
    }

    setupBackButtonHandler() {
        window.addEventListener('popstate', () => { this.handleBackButton(); });
        this.originalPushState = history.pushState;
        history.pushState = (...args) => {
            this.originalPushState.apply(history, args);
            this.currentState = args[0];
        };
    }

        generateSessionId() {
        const rand = Math.random().toString(36).substring(2, 11);
        const time = Date.now();
        return `S${time}_${rand}`;
    }

    handleBackButton() {
        const activeScreen = this.getEl('.screen.active');
        if (!activeScreen) return;
        const screenId = activeScreen.id;

        switch (screenId) {
            case 'startScreen':
                break;
            case 'avatarScreen':
            case 'nameEntryScreen':
                if (screenId === 'nameEntryScreen') this.showScreen('avatar');
                else if (screenId === 'avatarScreen') this.showScreen('start');
                break;
            case 'gameContainer':
                this.showModal('confirmExit');
                break;
            case 'levelCompleteScreen':
            case 'endScreen':
            case 'leaderboardScreen':
                this.showScreen('start');
                break;
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

    /* ------------------------------ تنقل/واجهات ------------------------------ */
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
        if (modal) modal.classList.add('active');
    }

    hideModal(nameOrId) {
        const modal = this.dom.modals[nameOrId] || document.getElementById(nameOrId);
        if (modal) modal.classList.remove('active');
    }

    showToast(message, type = 'info') {
        const c = this.getEl('#toast-container');
        if (!c) return;

        const now = Date.now();
        window.__toastLastActivity = now;

        const key = `${type}|${message}`;
        let t = c.querySelector(`.toast[data-key="${CSS.escape(key)}"]`);

        if (t) {
            const count = (parseInt(t.dataset.count || '1', 10) + 1);
            t.dataset.count = String(count);

            let badge = t.querySelector('.toast-counter');
            if (!badge) {
                badge = document.createElement('span');
                badge.className = 'toast-counter';
                t.insertBefore(badge, t.firstChild);
            }
            badge.textContent = `x${count}`;
            t.dataset.updated = String(now);
        } else {
            t = document.createElement('div');
            t.className = `toast ${type}`;
            t.dataset.key = key;
            t.dataset.count = '1';
            t.dataset.updated = String(now);
            t.setAttribute('role', 'alert');
            t.appendChild(document.createTextNode(message));
            c.appendChild(t);
        }

        if (window.__toastIdleTimer) clearTimeout(window.__toastIdleTimer);
        window.__toastIdleTimer = setTimeout(() => {
            const last = window.__toastLastActivity || 0;
            if (Date.now() - last >= 2000) {
                [...c.querySelectorAll('.toast')].forEach(el => el.remove());
            }
        }, 2000);
    }

    toggleTheme() {
      const newTheme = document.body.dataset.theme === 'dark' ? 'light' : 'dark';
      document.body.dataset.theme = newTheme;
      localStorage.setItem('theme', newTheme);

      const btn = this.getEl('.theme-toggle-btn');
      if (btn) {
        btn.textContent = (newTheme === 'dark') ? ICON_SUN : ICON_MOON;
      }
    }

    setupPaletteSelector() {
        const select = document.getElementById('paletteSelect');

        const saved = localStorage.getItem('palette') || 'classic';
        document.body.dataset.palette = saved;

        if (!select) return;
        select.value = saved;

        const updateBadge = () => {
            const badge = document.getElementById('paletteBadge');
            if (!badge) return;
            const label = getComputedStyle(document.body)
                .getPropertyValue('--palette-label')
                .replace(/['"]/g, '')
                .trim() || document.body.dataset.palette || 'classic';
            badge.textContent = label;
        };

        updateBadge();

        select.addEventListener('change', (e) => {
            const val = e.target.value || 'classic';
            document.body.dataset.palette = val;
            localStorage.setItem('palette', val);
            updateBadge();
            this.showToast('تم تغيير نمط الألوان.', 'info');
        });
    }

    /* ------------------------------ إدارة الصوت ------------------------------ */
    _createAudioPool(src, size = 6) {
        const list = [];
        for (let i = 0; i < size; i++) {
            const a = new Audio();
            a.preload = 'auto';
            a.src = src;
            list.push(a);
        }
        return { list, idx: 0 };
    }

    _playFromPool(pool, volume = 0.7) {
        if (!pool || !pool.list?.length) return;
        const a = pool.list[pool.idx];
        pool.idx = (pool.idx + 1) % pool.list.length;
        try {
            a.currentTime = 0;
            a.volume = volume;
            a.play().catch(() => {});
        } catch (_) {}
    }

    playSfx(name, volume = 0.7) { this._playFromPool(this.audioPools?.[name], volume); }
    playSound(name, volume = 0.7) { this.playSfx(name, volume); }

    _unlockAudioOnce = () => {
        if (!this.audioPools) return;
        try {
            for (const pool of Object.values(this.audioPools)) {
                const a = pool.list[0];
                a.muted = true;
                a.play().then(() => {
                    a.pause();
                    a.currentTime = 0;
                    a.muted = false;
                }).catch(() => {});
            }
        } catch (_) {}
        document.removeEventListener('pointerdown', this._unlockAudioOnce);
        document.removeEventListener('keydown', this._unlockAudioOnce);
    };

    async preloadAudio() {
        if (this._audioReady) return;
        const files = {
            correct: '/MS_AbuQusay/audio/correct.mp3',
            wrong:   '/MS_AbuQusay/audio/wrong.mp3',
            levelup: '/MS_AbuQusay/audio/levelup.mp3',
            win:     '/MS_AbuQusay/audio/win.mp3',
            loss:    '/MS_AbuQusay/audio/loss.mp3',
            start:   '/MS_AbuQusay/audio/start.mp3',
            click:   '/MS_AbuQusay/audio/ui-click.mp3',
            notify:  '/MS_AbuQusay/audio/notify.mp3',
            coin:    '/MS_AbuQusay/audio/coin.mp3',
            fadeout: '/MS_AbuQusay/audio/fadeout.mp3',
            whoosh:  '/MS_AbuQusay/audio/whoosh.mp3'
        };

        for (const [key, src] of Object.entries(files)) {
            const sz = (key === 'win' || key === 'loss') ? 6 : 4;
            this.audioPools[key] = this._createAudioPool(src, sz);
        }

        const loadPromises = [];
        try {
            for (const pool of Object.values(this.audioPools)) {
                const first = pool.list[0];
                const p = new Promise((resolve) => {
                    try {
                        first.oncanplaythrough = () => resolve();
                        first.onerror = () => resolve();
                    } catch (_) { resolve(); }
                });
                loadPromises.push(p);
            }
        } catch (_) {}
        await Promise.allSettled(loadPromises);

        document.addEventListener('pointerdown', this._unlockAudioOnce, { once: true });
        document.addEventListener('keydown', this._unlockAudioOnce, { once: true });

        this._audioReady = true;
    }

    /* ------------------------------ حماية النقرات ------------------------------ */
    guardAction(target, actionName, extraMs = 0) {
        const now = Date.now();
        const prev = this.lastActionAt.get(actionName) || 0;
        if (now - prev < this.config.CLICK_DEBOUNCE_MS + extraMs) return false;
        this.lastActionAt.set(actionName, now);

        if (target) {
            if (target.dataset.busy === '1') return false;
            target.dataset.busy = '1';
            target.setAttribute('aria-disabled', 'true');
            target.classList.add('is-busy');
            setTimeout(() => {
                target.dataset.busy = '0';
                target.removeAttribute('aria-disabled');
                target.classList.remove('is-busy');
            }, this.config.CLICK_DEBOUNCE_MS + extraMs);
        }
        return true;
    }

    /* ------------------------------ الاتصال/الحالة ------------------------------ */
    handleOnlineStatus()  { this.showToast('تم استعادة الاتصال بالإنترنت.', 'success'); }
    handleOfflineStatus() { this.showToast('لا يوجد اتصال بالإنترنت.', 'warning'); }

    /* ------------------------------ صور وأفاتار ------------------------------ */
    preloadImages(urls) {
        urls.forEach(url => {
            if (!this.imageCache.has(url)) {
                const img = new Image();
                img.src = url;
                this.imageCache.set(url, img);
            }
        });
    }

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
            'https://em-content.zobj.net/thumbs/120/apple/354/woman_1f469.png',
            'https://em-content.zobj.net/thumbs/120/apple/354/man_1f468.png',
            'https://em-content.zobj.net/thumbs/120/apple/354/person-beard_1f9d4.png',
            'https://em-content.zobj.net/thumbs/120/apple/354/old-man_1f474.png',
            'https://em-content.zobj.net/thumbs/120/apple/354/student_1f9d1-200d-1f393.png',
            'https://em-content.zobj.net/thumbs/120/apple/354/teacher_1f9d1-200d-1f3eb.png',
            'https://em-content.zobj.net/thumbs/120/apple/354/scientist_1f9d1-200d-1f52c.png',
            'https://em-content.zobj.net/thumbs/120/apple/354/artist_1f9d1-200d-1f3a8.png',
            'https://em-content.zobj.net/thumbs/120/apple/354/technologist_1f9d1-200d-1f4bb.png',
            'https://em-content.zobj.net/thumbs/120/apple/354/firefighter_1f9d1-200d-1f692.png',
            'https://em-content.zobj.net/thumbs/120/apple/354/pilot_1f9d1-200d-2708-fe0f.png'
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
    }

    selectAvatar(element) {
        this.getAllEl('.avatar-option.selected, .avatar-upload-btn.selected')
            .forEach(el => el.classList.remove('selected'));
        element.classList.add('selected');
        this.gameState.avatar = element.src;
        if (this.dom.confirmAvatarBtn) this.dom.confirmAvatarBtn.disabled = false;
    }

    handleAvatarUpload(event) {
        const file = event.target.files[0];
        if (file && file.type.startsWith('image/')) {

            if (file.size > 5 * 1024 * 1024) {
                this.showToast('حجم الصورة كبير جداً (أكثر من 5MB).', 'error');
                return;
            }

            const reader = new FileReader();
            reader.onload = e => {
                this.dom.imageToCrop.src = e.target.result;
                this.showModal('avatarEditor');
                setTimeout(() => {
                    if (this.cropper) this.cropper.destroy();
                    this.cropper = new Cropper(this.dom.imageToCrop, {
                        aspectRatio: 1, viewMode: 1, autoCropArea: 1
                    });
                }, 300);
            };
            reader.readAsDataURL(file);
        } else {
            this.showToast('الرجاء اختيار ملف صورة صالح.', 'error');
        }
    }

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
    }

    cleanupAvatarEditor() {
        try {
            if (this.cropper) {
                this.cropper.destroy();
                this.cropper = null;
            }
        } catch (_) {}
        if (this.dom?.imageToCrop) this.dom.imageToCrop.src = '';
        const input = this.getEl('#avatarUploadInput');
        if (input) input.value = '';
    }

    /* ------------------------------ بدء اللعبة ------------------------------ */
    setupInitialGameState() {
        this.gameState = {
            name: (this.dom.nameInput.value || '').trim(),
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
    }

    startGameFlow(levelIndex = 0) {
        this.gameState.level = levelIndex;
        this.updateScore(this.config.STARTING_SCORE, true);
        this.setupGameUI();
        this.showScreen('game');
        this.playSound('start');
        this.startLevel();
    }

    setupGameUI() {
        const avatar = this.getEl('#playerAvatar');
        if (avatar) avatar.src = this.gameState.avatar || '';
        const nameEl = this.getEl('#playerName');
        if (nameEl) nameEl.textContent = this.gameState.name || '';
        const idEl = this.getEl('#playerId');
        if (idEl) idEl.textContent = this.gameState.playerId || '';
    }

    /* ------------------------------ الأسئلة والمستويات ------------------------------ */
    startLevel() {
        const currentLevel = this.config.LEVELS[this.gameState.level];
        this.gameState.helpersUsed = { fiftyFifty: false, freezeTime: false };
        document.body.dataset.level = currentLevel.name;

        const badge = this.getEl('#currentLevelBadge');
        if (badge) badge.textContent = currentLevel.label;

        // 1) اجلب أسئلة المستوى بشكل آمن
        let levelQuestions = this.getLevelQuestions(currentLevel.name);
        if (!Array.isArray(levelQuestions)) {
            console.warn('[startLevel] getLevelQuestions did not return an array. Got:', typeof levelQuestions, levelQuestions);
            levelQuestions = [];
        }

        // 2) اخلط نسخة فقط مرة واحدة
        this.gameState.shuffledQuestions = this.shuffleArray(levelQuestions);

        // 3) لو ما في أسئلة، انهي المستوى فوراً (أو ارجع للشاشة السابقة حسب رغبتك)
        if (!this.gameState.shuffledQuestions.length) {
            console.warn('No questions for level:', currentLevel.name);
            this.levelComplete();
            return;
        }

        // 4) صفّر المؤشر وحدّث الواجهة
        this.gameState.questionIndex = 0;
        this.updateLevelProgressUI();
        this.fetchQuestion();
    }

    fetchQuestion() {
        const questions = this.gameState.shuffledQuestions || [];
        if (this.gameState.questionIndex >= questions.length) {
            this.levelComplete();
            return;
        }
        const q = questions[this.gameState.questionIndex];
        this.displayQuestion(q);
    }

    displayQuestion(qData) {
        // حماية: تأكد من أن قائمة الأسئلة والمُدخل صالحين
        if (!Array.isArray(this.gameState.shuffledQuestions)) {
            console.warn('[displayQuestion] shuffledQuestions is not array. Fixing…', this.gameState.shuffledQuestions);
            this.gameState.shuffledQuestions = [];
        }
        if (!qData) {
            console.warn('[displayQuestion] Missing qData, advancing…');
            this.gameState.questionIndex++;
            return this.fetchQuestion();
        }

        this.answerSubmitted = false;

        const { text, options, correctText } = this.resolveQuestionFields(qData);
        const safeOptions = Array.isArray(options) ? options.slice() : [];

        if (!text || safeOptions.length === 0) {
            this.showToast('تم تجاوز سؤال غير صالح.', 'error');
            this.gameState.skips++;
            this.gameState.questionIndex++;
            return this.fetchQuestion();
        }

        const totalQuestions = this.gameState.shuffledQuestions.length;
        this.getEl('#questionCounter').textContent = `السؤال ${this.gameState.questionIndex + 1} من ${totalQuestions}`;
        this.dom.questionText.textContent = text;
        this.dom.optionsGrid.innerHTML = '';

        // اخلط الخيارات فقط للعرض
        const displayOptions = this.shuffleArray(safeOptions);
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
    }

    checkAnswer(selectedButton = null) {
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
            const correctButton = this.dom.optionsGrid?.querySelector('[data-correct="true"]');
            correctButton?.classList.add('correct');
            this.gameState.wrongAnswers++;
            this.updateScore(this.gameState.currentScore - 100);
            this.playSound('wrong');
            this.showToast('إجابة خاطئة. -100 نقطة', 'error');
        }

        this.performanceMetrics.questionsAnswered++;
        this.performanceMetrics.totalTimeSpent += (this.config.QUESTION_TIME - this.timer.total);

        this.gameState.questionIndex++;
        this.updateGameStatsUI();

        const tid = setTimeout(() => { this.fetchQuestion(); }, 2000);
        this.cleanupQueue.push({ type: 'timeout', id: tid });
    }

    startTimer() {
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
    }

    handleTimeout() {
        const anyWrongBtn = this.dom.optionsGrid?.querySelector('.option-btn:not([data-correct="true"])');
        this.checkAnswer(anyWrongBtn || null);
    }

    levelComplete() {
        const isLast = this.gameState.level >= this.config.LEVELS.length - 1;
        if (isLast) {
            this.endGame(true);
            return;
        }

        const t = this.getEl('#levelCompleteTitle');
        if (t) t.textContent = `🎉 أكملت المستوى ${this.config.LEVELS[this.gameState.level].label}!`;
        const sc = this.getEl('#levelScore'); if (sc) sc.textContent = this.formatNumber(this.gameState.currentScore);
        const er = this.getEl('#levelErrors'); if (er) er.textContent = this.gameState.wrongAnswers;
        const cr = this.getEl('#levelCorrect'); if (cr) cr.textContent = this.gameState.correctAnswers;
        this.playSound('levelup');
        this.showScreen('levelComplete');
    }

    nextLevel() {
        this.gameState.level++;
        if (this.gameState.level >= this.config.LEVELS.length) {
            this.endGame(true);
        } else {
            this.showScreen('game');
            this.startLevel();
        }
    }

    /* ------------------------------ نقاط/إحصاءات ------------------------------ */
    updateScore(newScore, isReset = false) {
        this.gameState.currentScore = Math.max(0, newScore);
        if (this.dom.scoreDisplay) this.dom.scoreDisplay.textContent = this.formatNumber(this.gameState.currentScore);
        this.updateGameStatsUI();

        if (!isReset && this.dom.scoreDisplay) {
            this.dom.scoreDisplay.style.transform = 'scale(1.1)';
            setTimeout(() => { this.dom.scoreDisplay.style.transform = 'scale(1)'; }, 200);
        }
    }

    updateLevelProgressUI() {
        this.getAllEl('.level-indicator').forEach((ind, i) => {
            ind.classList.toggle('active', i === this.gameState.level);
            ind.classList.toggle('completed', i < this.gameState.level);
        });
    }

    updateGameStatsUI() {
        const wrongEl = this.getEl('#wrongAnswersCount');
        const skipEl = this.getEl('#skipCount');
        const skipCostEl = this.getEl('#skipCost');

        if (wrongEl) wrongEl.textContent = this.gameState.wrongAnswers;
        if (skipEl)  skipEl.textContent  = this.gameState.skips;
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
    }

    /* ------------------------------ المساعدات ------------------------------ */
    useHelper(btn) {
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
            this.showToast(`تم استخدام المساعدة. -${cost} نقطة`, 'info');
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
            this.getEl('.timer-bar')?.classList.add('frozen');
            setTimeout(() => {
                this.timer.isFrozen = false;
                this.getEl('.timer-bar')?.classList.remove('frozen');
            }, 10000);
        }
    }

    /* ------------------------------ حساب النتيجة النهائية ------------------------------ */
    calculateFinalStats(completedAll) {
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
    }

    displayFinalStats(stats) {
        const s = (sel) => this.getEl(sel);

        const elName = s('#finalName');
        if (elName) elName.textContent = stats.name;

        const elId = s('#finalId');
        if (elId) elId.textContent = stats.player_id;

        const elAttempt = s('#finalAttemptNumber');
        if (elAttempt) elAttempt.textContent = stats.attempt_number || '--';

        const elCorrect = s('#finalCorrect');
        if (elCorrect) elCorrect.textContent = stats.correct_answers;

        const elWrong = s('#finalWrong');
        if (elWrong) elWrong.textContent = stats.wrong_answers;

        const elSkips = s('#finalSkips');
        if (elSkips) elSkips.textContent = stats.skips;

        const elScore = s('#finalScore');
        if (elScore) elScore.textContent = this.formatNumber(stats.score);

        const elTotalTime = s('#totalTime');
        if (elTotalTime) elTotalTime.textContent = this.formatTime(stats.total_time);

        const elLevel = s('#finalLevel');
        if (elLevel) elLevel.textContent = stats.level;

        const elAcc = s('#finalAccuracy');
        if (elAcc) elAcc.textContent = `${stats.accuracy}%`;

        const elAvg = s('#finalAvgTime');
        if (elAvg) elAvg.textContent = `${this.formatTime(stats.avg_time)}`;

        const elPerf = s('#performanceText');
        if (elPerf) elPerf.textContent = stats.performance_rating;
    }

    getPerformanceRating(accuracy) {
        if (accuracy >= 90) return 'ممتاز 🏆';
        if (accuracy >= 75) return 'جيد جدًا ⭐';
        if (accuracy >= 60) return 'جيد 👍';
        if (accuracy >= 40) return 'مقبول 👌';
        return 'يحتاج تحسين 📈';
    }

    /* ------------------------------ إنهاء اللعبة وإعادة اللعب ------------------------------ */
    async endGame(completedAllLevels = false) {
        this.clearAllTimers();
        this.hideModal('confirmExit');

        const baseStats = this.calculateFinalStats(completedAllLevels);

        try {
            const perf = await this.ratePerformance(baseStats); // تُعرّف في الجزء 2/2
            baseStats.performance_rating = perf.label;
            baseStats.performance_score  = perf.score;
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
                this.showToast('تعذّر حفظ النتيجة. سنعيد المحاولة لاحقاً.', 'error');
            }
        }).catch(() => {});

        setTimeout(() => { this.cleanupSession({ keepEndScreen: true }); }, 800);
    }

    async playAgainGuarded() {
        const remain = this.getCooldownRemaining();
        if (remain > 0) {
            this.updateRetryCountdownUI(remain);
            this.showToast(`انتظر ${remain} ثانية للمحاولة مجدداً.`, 'info');
            return;
        }
        await this.cleanupSession();
        this.currentSessionId = this.generateSessionId();

        if (this._endCountdownInterval) {
            clearInterval(this._endCountdownInterval);
            this._endCountdownInterval = null;
        }
        window.location.reload();
    }

    startRetryCountdownUI() {
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
    }

    updateRetryCountdownUI(remain) {
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
    }

    startFromHomeGuarded() {
        const remain = this.getCooldownRemaining();
        if (remain > 0) {
            this.updateStartCooldownUI(remain);
            this.showToast(`انتظر ${remain} ثانية للبدء مجدداً.`, 'info');
            return;
        }
        this.showScreen('avatar');
    }

    startStartCooldownUI() {
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
    }

    updateStartCooldownUI(remain) {
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
    }

    /* ------------------------------ تنظيف الجلسة ------------------------------ */
    async cleanupSession(opts = {}) {
        const { keepEndScreen = false } = opts;
        this.clearAllTimers();
        this.abortPendingRequests();
        this.removeTemporaryListeners();
        this.clearSessionStorage();
        this.resetGameState();
        this.resetUI(keepEndScreen);
        await this.processCleanupQueue();
    }

    clearAllTimers() {
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
    }

    abortPendingRequests() {
        this.pendingRequests.forEach(controller => {
            if (!controller) return;
            if (controller.__skipAbortOnCleanup) return;
            if (!controller.signal.aborted) controller.abort();
        });
        this.pendingRequests.clear();
    }

    removeTemporaryListeners() {
        this.cleanupQueue.forEach(i => {
            if (i.type === 'listener' && i.element && i.handler) {
                i.element.removeEventListener(i.event, i.handler);
            }
        });
    }

    clearSessionStorage() {
        try {
            const keysToRemove = [];
            for (let i = 0; i < sessionStorage.length; i++) {
                const key = sessionStorage.key(i);
                if (key && key.startsWith('quiz_')) keysToRemove.push(key);
            }
            keysToRemove.forEach(k => sessionStorage.removeItem(k));

            ['currentLevel','currentIndex','shuffledQuestions','activeLifelines','tempScore','tempTime','attemptDraft']
                .forEach(k => localStorage.removeItem(k));
        } catch (e) {
            console.warn('Failed to clear session storage:', e);
        }
    }

    resetGameState() {
        this.gameState = {
            name: this.gameState.name || '',
            avatar: this.gameState.avatar || '',
            playerId: this.gameState.playerId || '',
            deviceId: this.getOrSetDeviceId(),
            sessionId: this.generateSessionId()
        };
        this.timer = { interval: null, isFrozen: false, total: 0 };
        this.answerSubmitted = false;
        this.performanceMetrics = { startTime: 0, questionsAnswered: 0, totalTimeSpent: 0 };
    }

    /* ------------------------------ أدوات مساعدة عامة ------------------------------ */
    validateNameInput() {
        const name = (this.dom.nameInput.value || '').trim();
        const isValid = name.length >= 3 && name.length <= 15;
        this.dom.nameError.textContent = isValid ? '' : 'يجب أن يتراوح طول الاسم بين ٣ - ١٥ حرفًا';
        this.dom.nameError.classList.toggle('show', !isValid);
        this.dom.confirmNameBtn.disabled = !isValid;
    }

    handleNameConfirmation() {
        if (this.dom.confirmNameBtn.disabled) return;
        this.setupInitialGameState();
        this.startGameFlow(0);
    }

    formatTime(totalSeconds) {
        const total = Math.floor(Number(totalSeconds) || 0);
        const minutes = Math.floor(total / 60);
        const seconds = total % 60;
        return `${minutes}:${seconds.toString().padStart(2, '0')}`;
        // ملاحظة: avg_time يُعرض بنفس التنسيق لثبات واجهة المستخدم
    }

    formatNumber(num) { return new Intl.NumberFormat('ar-EG').format(Number(num) || 0); }

    normalize(s) {
        let t = String(s || '').trim().toLowerCase();

        // إزالة التشكيل العربي
        const tashkeel = /[\u0610-\u061A\u064B-\u065F\u06D6-\u06ED]/g;
        t = t.replace(tashkeel, '');

        // توحيد حروف شائعة الاختلاف
        t = t
            .replace(/[إأٱآا]/g, 'ا')
            .replace(/ى/g, 'ي')
            .replace(/ئ/g, 'ي')
            .replace(/ؤ/g, 'و')
            .replace(/ة/g, 'ه');

        // إزالة غير الحروف/الأرقام مع الإبقاء على المسافات
        t = t.replace(/[^\p{L}\p{N}\s]/gu, '');
        // تنظيف الفراغات
        t = t.replace(/\s+/g, ' ').trim();

        return t;
    }

    resolveQuestionFields(q) {
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
    }

    getLevelQuestions(levelName) {
        try {
            // لو الأسئلة Array مسطّحة وفيها level/difficulty
            if (Array.isArray(this.questions)) {
                const lvl = this.normalize(levelName);
                const arr = this.questions.filter(q =>
                    this.normalize(q.level) === lvl ||
                    this.normalize(q.difficulty) === lvl
                );
                return Array.isArray(arr) && arr.length ? arr.slice() : this.questions.slice();
            }

            // لو الأسئلة كائن مفهرس بمفاتيح
            const direct =
                this.questions?.[levelName] ||
                this.questions?.[levelName + 'Questions'] ||
                this.questions?.[levelName + '_questions'] ||
                this.questions?.[levelName + '_list'];

            if (Array.isArray(direct)) return direct.slice();
            if (Array.isArray(this.questions?.questions)) return this.questions.questions.slice();

            // دمج أي Arrays داخل الكائن
            const merged = Object.values(this.questions || {}).filter(Array.isArray).flat();
            return Array.isArray(merged) ? merged.slice() : [];
        } catch (e) {
            console.warn('[getLevelQuestions] fallback to [] due to error:', e);
            return [];
        }
    }

    shuffleArray(arr) {
        // حوّل لأي مصفوفة آمنة ولا تعيد طول غير صالح
        const a = Array.isArray(arr) ? arr.slice() : [];
        const len = Number.isFinite(a.length) ? a.length : 0;

        // حماية إضافية: إذا الطول خارج النطاق المنطقي، أعد مصفوفة فارغة
        if (len < 0 || len > 100000) {
            console.warn('[shuffleArray] invalid length:', len, { inputType: typeof arr });
            return [];
        }

        for (let i = len - 1; i > 0; i--) {
            const j = Math.floor(Math.random() * (i + 1));
            const tmp = a[i];
            a[i] = a[j];
            a[j] = tmp;
        }
        return a;
    }

    normalizeTo100(value, min, max) {
        const v = Math.max(min, Math.min(max, Number(value) || 0));
        return Math.round(((max - v) / (max - min)) * 100);
    }

    stdDev(arr) {
        if (!arr || arr.length < 2) return 0;
        const mean = arr.reduce((a, b) => a + Number(b || 0), 0) / arr.length;
        const variance = arr.reduce((s, v) => s + Math.pow(Number(v || 0) - mean, 2), 0) / (arr.length - 1);
        return Math.sqrt(variance);
    }

    mapPerformanceLabel(score, { completed_all = false, level = '' } = {}) {
        if (completed_all && (level === 'مستحيل' || level === 'impossible')) score = Math.max(score, 80);
        if (score >= 97) return 'احترافي 🧠';
        if (score >= 92) return 'مذهل 🌟';
        if (score >= 85) return 'ممتاز 🏆';
        if (score >= 75) return 'جيد جدًا ⭐';
        if (score >= 62) return 'جيد 👍';
        if (score >= 50) return 'مقبول 👌';
        if (score >= 35) return 'يحتاج إلى تحسين 📈';
        return 'ضعيف 🧩';
    }

    /* ------------------------------ مشاركة النتائج ------------------------------ */
    getShareTextForX() {
        const name = this.getEl('#finalName')?.textContent || '';
        const attempt = this.getEl('#finalAttemptNumber')?.textContent || '';
        const correct = this.getEl('#finalCorrect')?.textContent || '0';
        const skips = this.getEl('#finalSkips')?.textContent || '0';
        const level = this.getEl('#finalLevel')?.textContent || '';
        const acc = this.getEl('#finalAccuracy')?.textContent || '0%';
        const avg = this.getEl('#finalAvgTime')?.textContent || '0:00 / سؤال';
        const perf = this.getEl('#performanceText')?.textContent || '';

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
    }

    shareOnX() {
        const text = this.getShareTextForX();
        const url = `https://twitter.com/intent/tweet?text=${encodeURIComponent(text)}`;
        window.open(url, '_blank');
    }

    shareOnInstagram() {
        const text = this.getShareTextForX();
        navigator.clipboard.writeText(text)
            .then(() => this.showToast('تم نسخ النتيجة لمشاركتها!', 'success'))
            .catch(() => this.showToast('فشل نسخ النتيجة.', 'error'));
    }

    /* ------------------------------ معرفات/جلسة/تبريد ------------------------------ */
    simpleHash(s) {
        let h = 0;
        for (let i = 0; i < s.length; i++) { h = ((h << 5) - h) + s.charCodeAt(i); h |= 0; }
        return String(Math.abs(h));
    }

    getOrSetDeviceId() {
        let deviceId;
        try { deviceId = localStorage.getItem('quizGameDeviceId'); } catch (_) {}
        if (!deviceId) {
            deviceId = 'D' + Date.now().toString(36) + Math.random().toString(36).substring(2, 11).toUpperCase();
            try { localStorage.setItem('quizGameDeviceId', deviceId); } catch (_) {}
        }
        return deviceId;
    }

    getCooldownKey() {
        const device = this.gameState?.deviceId || this.getOrSetDeviceId();
        return `quizCooldown:${device}`;
    }

    setCooldown(seconds = this.config.COOLDOWN_SECONDS) {
        const until = Date.now() + (Math.max(1, seconds) * 1000);
        try { localStorage.setItem(this.getCooldownKey(), String(until)); } catch (_) {}
    }

    getCooldownRemaining() {
        try {
            const v = Number(localStorage.getItem(this.getCooldownKey()) || 0);
            const diff = Math.ceil((v - Date.now()) / 1000);
            return Math.max(0, diff);
        } catch (_) { return 0; }
    }

    clearCooldown() {
        try { localStorage.removeItem(this.getCooldownKey()); } catch (_) {}
    }
}

/* =========================
   إلحاقات للصف (الجزء 2/2)
   ========================= */
Object.assign(QuizGame.prototype, {
  /* --------- إعادة الضبط والتنظيف --------- */
  resetUI(keepEndScreen = false) {
    this.getAllEl('.level-indicator').forEach(ind => ind.classList.remove('active', 'completed'));
    const sc = this.getEl('#currentScore'); if (sc) sc.textContent = '100';
    const wr = this.getEl('#wrongAnswersCount'); if (wr) wr.textContent = '0';
    const sk = this.getEl('#skipCount'); if (sk) sk.textContent = '0';
    Object.values(this.dom.screens).forEach(s => s?.classList?.remove('active'));
    const target = keepEndScreen ? this.dom.screens.end : this.dom.screens.start;
    target?.classList?.add('active');
  },

  async processCleanupQueue() {
    this.cleanupQueue.forEach(item => {
      if (item.type === 'url' && item.value) {
        try { URL.revokeObjectURL(item.value); } catch (_) {}
      }
    });
    const ps = this.cleanupQueue.filter(i => i.promise).map(i => i.promise.catch(() => {}));
    await Promise.allSettled(ps);
    this.cleanupQueue = this.cleanupQueue.filter(i => i.keep === true);
  },

  /* --------- الشبكة والحفظ والأسئلة --------- */
  _tx: { timeoutMs: 10000, maxRetries: 2 },

  async _postJson(url, body, { timeoutMs = this._tx.timeoutMs, retries = this._tx.maxRetries } = {}) {
    const headers = { 'Content-Type': 'application/json', 'x-app-key': this.config.APP_KEY };
    const controller = new AbortController();
    const t = setTimeout(() => { try { controller.abort('timeout'); } catch (_) {} }, timeoutMs);

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
      try { json = text ? JSON.parse(text) : {}; } catch (_) {}
      if (!res.ok) {
        const err = new Error(`HTTP ${res.status}${text ? `: ${text}` : ''}`);
        err.status = res.status; err.body = text; throw err;
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
    } finally { clearTimeout(t); }
  },

  async saveResultsToSupabase(resultsData) {
    const payload = {
      device_id: resultsData?.device_id || this.getOrSetDeviceId(),
      session_id: resultsData?.session_id || (this.gameState?.sessionId || this.currentSessionId || this.generateSessionId()),
      ...resultsData
    };
    try {
      const json = await this._postJson(this.config.EDGE_SAVE_URL, payload);
      const attemptNumber = json.attempt_number || json.attemptNumber || null;
      return { attemptNumber, error: null };
    } catch (error) {
      console.error('Failed to save results:', error);
      return { attemptNumber: null, error: String((error && error.message) || error) };
    }
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
        } catch (e) { console.warn('Failed to cache questions:', e); }
        return true;
      }
      throw new Error('Invalid questions data');
    } catch (err) {
      console.error('Failed to load questions:', err);
      this.showToast('خطأ في تحميل الأسئلة', 'error');
      return false;
    }
  },

  /* --------- مؤشر "آخر تحديث" للوحة الصدارة --------- */
  _setLbLastUpdatedText(ts, fromCache = false) {
    const info = document.getElementById('lbLastUpdated');
    if (!info) return;
    if (!ts) { info.textContent = ''; return; }
    const sec = Math.max(0, Math.round((Date.now() - ts) / 1000));
    info.textContent = fromCache ? `آخر تحديث (كاش): منذ ${sec} ثانية` : `آخر تحديث: منذ ${sec} ثانية`;
  },

  _startLbTicker(ts, fromCache = false) {
    if (this._lbTicker) clearInterval(this._lbTicker);
    this._setLbLastUpdatedText(ts, fromCache);
    this._lbTicker = setInterval(() => this._setLbLastUpdatedText(ts, fromCache), 1000);
  },

  _stopLbTicker() {
    if (this._lbTicker) { clearInterval(this._lbTicker); this._lbTicker = null; }
  },

  /* --------- لوحة الصدارة --------- */
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

    const attemptN = (mode === 'attempt') ? Number(this.dom.lbAttempt?.value || 1) : null;
    const cacheKey = `${mode}_${attemptN || ''}`;
    const cached = this.leaderboardCache.get(cacheKey);
    const CACHE_DURATION_MS = 60000;

    if (cached && (Date.now() - cached.timestamp < CACHE_DURATION_MS)) {
      this.renderLeaderboard(cached.data);
      this._startLbTicker(cached.timestamp, true);
      if (mode === 'attempt') await this.updateAttemptsFilter(true);
      return;
    }

    try {
      let rows;
      if (mode === 'attempt') {
        await this.updateAttemptsFilter();
        const currentAttemptN = Number(this.dom.lbAttempt?.value || 1);

        const newCacheKey = `${mode}_${currentAttemptN}`;
        const newCached = this.leaderboardCache.get(newCacheKey);
        if (newCached && (Date.now() - newCached.timestamp < CACHE_DURATION_MS)) {
          this.renderLeaderboard(newCached.data);
          return;
        }

        rows = await this._postJson(LB_URL, { mode: 'attempt', attempt: currentAttemptN });
        this.leaderboardCache.set(newCacheKey, { data: rows || [], timestamp: Date.now() });
        this._startLbTicker(Date.now(), false);
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
        this.leaderboardCache.set(cacheKey, { data: rows || [], timestamp: Date.now() });
        this._startLbTicker(Date.now(), false);
      }

      this.renderLeaderboard((rows || []).slice(0, 50));
    } catch (e) {
      console.error('Error loading leaderboard:', e);
      if (box) box.innerHTML = '<p>حدث خطأ في تحميل لوحة الصدارة.</p>';
    }
  },

  async updateAttemptsFilter(useCache = false) {
    const CACHE_KEY = 'maxAttempt';
    const CACHE_DURATION_MS = 60000;

    if (useCache) {
      const cached = this.leaderboardCache.get(CACHE_KEY);
      if (cached && (Date.now() - cached.timestamp < CACHE_DURATION_MS)) {
        this.populateAttemptsFilter(cached.data.maxAttempt);
        return;
      }
    }

    const LB_URL = this.config.EDGE_LEADERBOARD_URL ||
                   (this.config.SUPABASE_URL + '/functions/v1/leaderboard');
    try {
      const { maxAttempt = 1 } = await this._postJson(LB_URL, { mode: 'maxAttempt' });
      this.leaderboardCache.set(CACHE_KEY, { data: { maxAttempt }, timestamp: Date.now() });
      this.populateAttemptsFilter(maxAttempt);
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
        if (rank <= 3) { li.classList.add(`rank-${rank}`); rankDisplay = medals[rank - 1]; }
        else { rankDisplay = rank; }
        rank++;
      }

      li.innerHTML = `
        <span class="leaderboard-rank">${rankDisplay}</span>
        <img src="${p.avatar || ''}" alt="صورة ${p.name || ''}" class="leaderboard-avatar" loading="lazy" style="visibility:${p.avatar ? 'visible':'hidden'}">
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

  populateAttemptsFilter(maxAttempt) {
    if (!this.dom.lbAttempt) return;
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
  },

  showPlayerDetails(player) {
    this.getEl('#detailsName').textContent = player.name || 'غير معروف';
    this.getEl('#detailsPlayerId').textContent = player.player_id || 'N/A';
    const avatarEl = this.getEl('#detailsAvatar');
    if (avatarEl) { avatarEl.src = player.avatar || ''; avatarEl.style.visibility = player.avatar ? 'visible' : 'hidden'; }

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
  },

  /* --------- تقييم الأداء --------- */
  async ratePerformance(current) {
    // في النسخة الحالية لا نقرأ تاريخاً فعلياً — يمكن ربطه لاحقاً.
    const history = [];

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
    if (['medium','متوسط'].includes(lvlName)) levelBonus += 10;
    else if (['hard','صعب'].includes(lvlName)) levelBonus += 25;
    else if (['impossible','مستحيل'].includes(lvlName)) levelBonus += 40;
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

/* =========================
   تشغيل التطبيق بعد التحميل
   ========================= */
document.addEventListener('DOMContentLoaded', () => {
  const savedTheme = localStorage.getItem('theme') || 'dark';
  document.body.dataset.theme = savedTheme;
  const toggleBtn = document.querySelector('.theme-toggle-btn');
  if (toggleBtn) toggleBtn.textContent = (savedTheme === 'dark') ? ICON_SUN : ICON_MOON;

  new QuizGame();

  // حوار المساعدة (Robot Assist)
  (function () {
    const $ = (s, r = document) => r.querySelector(s);
    const fab = $('#robotHelpFab');
    const dlg = $('#robotAssistDialog');
    const grid = $('#assistGrid');
    const btnClose = dlg?.querySelector('.assist-close');
    if (!fab || !dlg || !grid) return;

    const cards = [
      { title: 'النقاط', icon: '⚖️', body: ['كل إجابة صحيحة تمنحك +100 نقطة.', 'الإجابة الخاطئة تخصم 100 نقطة من رصيدك.'] },
      { title: 'المساعدات', icon: '🛠️', list: ['التخطي مجاني دائمًا.', '50:50 يحذف خيارين خاطئين.', 'تجميد الوقت يوقف المؤقت 10 ثوانٍ.', 'تُعاد المساعدات مع بداية أول ثلاثة مستويات جديدة.'] },
      { title: 'المستويات', icon: '🎯', body: ['تدرّج الصعوبة: سهل → متوسط → صعب → مستحيل.'] },
      { title: 'مساعدة التخطي', icon: '⏭️', body: ['لا توجد حدود لعدد مرات استخدام ميزة التخطي خلال أول ثلاثة مستويات.'] },
      { title: 'المستوى المستحيل', icon: '🚫', body: ['في هذا المستوى لا تتوفر أي نوع من المساعدات.'] },
      { title: 'مشاركة النتائج', icon: '📢', body: ['يمكنك مشاركة نتيجتك مباشرة عبر منصة إكس.', 'اضغط على أيقونة إكس في شاشة النتائج.', 'سيُجهّز لك منشور تلقائي جاهز للنشر.'] },
      { title: 'لوحة الصدارة', icon: '🏆', body: ['يمكنك الاطّلاع على نتائجك ونتائج اللاعبين الآخرين.', 'اضغط على أي اسم في قائمة لوحة الصدارة لتظهر تفاصيل أدائه.'] },
      { title: 'تصفية النتائج', icon: '🎚️', body: ['استخدم فلتر النتائج في لوحة الصدارة.', 'يمكنك عرض النتائج حسب الأفضل أو الأعلى دقة أو الأسرع.', 'كما يمكنك تصفيتها حسب عدد المحاولات.'] },
      { title: 'الدعم', icon: '📩', html: `
          <p>للاقتراحات أو الإبلاغ عن مشكلة:</p>
          <ul>
            <li><a href="https://x.com/_MS_AbuQusay?t=hs_J87d1xR6dPnIVtNstPg&s=09" target="_blank" rel="noopener noreferrer">إكس</a></li>
            <li><a href="https://www.instagram.com/_ms_abuqusay?igsh=OTRmODR1cTNkcXV1" target="_blank" rel="noopener noreferrer">إنستغرام</a></li>
          </ul>
        `}
    ];

    function renderCards(items) {
      grid.setAttribute('aria-busy', 'true');
      grid.innerHTML = '';
      items.forEach((item, idx) => {
        const el = document.createElement('article');
        el.className = 'assist-card';
        el.style.animationDelay = (idx * 0.08) + 's';
        const head = `<h4><span class="icon">${item.icon || ''}</span><span>${item.title || ''}</span></h4>`;
        let content = '';
        if (item.html) content = String(item.html);
        else if (Array.isArray(item.list)) content = '<ul>' + item.list.map(li => `<li>${li}</li>`).join('') + '</ul>';
        else if (Array.isArray(item.body)) content = item.body.map(p => `<p>${p}</p>`).join('');
        el.innerHTML = head + content;
        grid.appendChild(el);
      });
      grid.removeAttribute('aria-busy');
    }

    function openDialog() {
      renderCards(cards);
      const reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
      if (reduce) { document.documentElement.style.scrollBehavior = 'auto'; }
      if (typeof dlg.showModal === 'function') dlg.showModal();
      else dlg.setAttribute('open', '');
    }
    function closeDialog() { if (typeof dlg.close === 'function') dlg.close(); else dlg.removeAttribute('open'); }

    fab.addEventListener('click', openDialog);
    btnClose?.addEventListener('click', closeDialog);
    dlg.addEventListener('cancel', (e) => { e.preventDefault(); closeDialog(); });
    dlg.addEventListener('click', (e) => {
      const box = e.currentTarget.querySelector('.assist-wrap');
      if (!box) return;
      const rect = box.getBoundingClientRect();
      const inside = e.clientX >= rect.left && e.clientX <= rect.right &&
                     e.clientY >= rect.top && e.clientY <= rect.bottom;
      if (!inside) closeDialog();
    });

    window.AssistCards = {
      open: openDialog,
      close: closeDialog,
      set(items) { if (Array.isArray(items)) { renderCards(items); } }
    };
  })();
});
