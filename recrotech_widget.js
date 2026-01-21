// RecroTech Widget Demo JavaScript
// test_client.html fonksiyonlarını widget formatına uyarlanmış versiyonu

// API Base URL - Production'da bu değiştirilecek
const RC_API_URL = 'https://rai.recrotechgroup.com'; //window.location.origin || 'http://localhost:8011';

// Turkish state translations
const RC_STATE_LABELS = {
    'standing': 'BEKLİYOR',
    'listening': 'DİNLİYOR',
    'thinking': 'DÜŞÜNÜYOR',
    'talking': 'KONUŞUYOR',
    'loading': 'YÜKLENİYOR'
};

// Video files to preload
const RC_VIDEO_FILES = {
    'standing': 'standing.mp4',
    'listening': 'listening.mp4',
    'thinking': 'thinking.mp4',
    'talking': 'talking.mp4',
    'writing': 'writing.mp4'
};

/**
 * VideoAssetLoader - Preloads videos as Blobs for zero-latency playback
 */
class VideoAssetLoader {
    constructor() {
        this.blobUrls = {};      // state -> blob URL mapping
        this.loadedCount = 0;
        this.totalCount = Object.keys(RC_VIDEO_FILES).length;
        this.isReady = false;
    }

    /**
     * Preload all videos into RAM as Blob URLs
     */
    async preloadAll(onProgress, onComplete) {
        const entries = Object.entries(RC_VIDEO_FILES);

        for (const [state, filename] of entries) {
            try {
                const url = `${RC_API_URL}/avatar_videos/${filename}`;
                const response = await fetch(url);

                if (!response.ok) {
                    throw new Error(`HTTP ${response.status}`);
                }

                const blob = await response.blob();
                const blobUrl = URL.createObjectURL(blob);
                this.blobUrls[state] = blobUrl;
                this.loadedCount++;

                if (onProgress) {
                    onProgress(state, this.loadedCount, this.totalCount);
                }
            } catch (error) {
                console.error(`Failed to preload ${filename}:`, error);
                // Fallback to direct URL if blob fails
                this.blobUrls[state] = `${RC_API_URL}/avatar_videos/${filename}`;
                this.loadedCount++;
            }
        }

        this.isReady = true;
        if (onComplete) {
            onComplete(this.blobUrls);
        }
    }

    getBlobUrl(state) {
        return this.blobUrls[state] || null;
    }
}

// Global asset loader instance
const rcAssetLoader = new VideoAssetLoader();

// Widget state
let rcWidgetState = {
    isMinimized: false,
    currentState: 'loading',
    logEntries: [],
    // Microphone recording state
    isRecording: false,
    mediaRecorder: null,
    audioChunks: [],
    // Silence detection state
    audioContext: null,
    analyser: null,
    silenceTimer: null,
    isAnalyzing: false,
    volumeThreshold: 0.02,      // Volume threshold (increased from 0.01)
    silenceTimeout: 1500,        // Silence duration in ms
    // Audio playback
    currentAudio: null,          // Currently playing audio
    // Video loading
    videosReady: false           // True when all blobs loaded
};

// Initialize widget on page load
document.addEventListener('DOMContentLoaded', function () {
    rcInitWidget();
});

/**
 * Initialize the widget
 */
function rcInitWidget() {
    rcLog('Widget başlatılıyor...', 'info');

    // Start avatar stream
    rcStartAvatarStream();

    // Update current state periodically
    rcUpdateCurrentState();
    setInterval(rcUpdateCurrentState, 2000);

    // Setup Enter key handlers and focus events
    const chatInput = document.getElementById('rc-chat-input');
    const speakInput = document.getElementById('rc-speak-input');

    // Chat input focus/blur - listening when typing
    chatInput.addEventListener('focus', function () {
        rcChangeVideo('listening');
        rcLog('👂 Mesaj yazılıyor...', 'info');
    });

    chatInput.addEventListener('blur', function () {
        if (!chatInput.value.trim()) {
            setTimeout(() => {
                if (document.activeElement !== chatInput && !chatInput.value.trim()) {
                    rcChangeVideo('standing');
                }
            }, 300);
        }
    });

    // Chat input enter - send message
    chatInput.addEventListener('keypress', function (e) {
        if (e.key === 'Enter' && !e.shiftKey) {
            e.preventDefault();
            rcSendChat();
        }
    });

    // Speak input event handlers
    speakInput.addEventListener('keypress', function (e) {
        if (e.key === 'Enter' && !e.shiftKey) {
            e.preventDefault();
            rcSpeak();
        }
    });

    // Speak input focus - listening moduna geç
    speakInput.addEventListener('focus', function () {
        rcChangeVideo('listening');
        rcLog('👂 Konuşturulacak metin yazılıyor...', 'info');
    });

    // Speak input blur - eğer boşsa standing'e dön
    speakInput.addEventListener('blur', function () {
        if (!speakInput.value.trim()) {
            // Kısa bir gecikme ile standing'e dön (kullanıcı başka input'a geçebilir)
            setTimeout(() => {
                // Eğer hala focus yoksa ve input boşsa standing'e dön
                if (document.activeElement !== chatInput && document.activeElement !== speakInput && !speakInput.value.trim()) {
                    rcChangeVideo('standing');
                }
            }, 300);
        }
    });

    // Microphone button event listener
    const micBtn = document.getElementById('rc-mic-btn');
    if (micBtn) {
        micBtn.addEventListener('click', rcToggleMicRecording);
    }

    // Send button event listener
    const sendBtn = document.getElementById('rc-send-btn');
    if (sendBtn) {
        sendBtn.addEventListener('click', rcSendChat);
    }

    rcLog('Widget hazır!', 'success');
}

/**
 * Toggle widget minimize/maximize
 */
function rcToggleWidget() {
    const widget = document.getElementById('rcWidget');
    const toggle = document.getElementById('rcWidgetToggle');

    rcWidgetState.isMinimized = !rcWidgetState.isMinimized;

    if (rcWidgetState.isMinimized) {
        widget.classList.add('minimized');
        toggle.classList.add('visible');
    } else {
        widget.classList.remove('minimized');
        toggle.classList.remove('visible');
    }
}

/**
 * Start avatar video - Blob Preloading System
 * Videos are fetched as blobs into RAM for zero-latency playback
 */
function rcStartAvatarStream() {
    const placeholder = document.getElementById('rc-avatar-placeholder');
    const videoStack = document.getElementById('rc-video-stack');

    if (!videoStack) {
        rcLog('Video stack bulunamadı', 'error');
        return;
    }

    // Update placeholder text
    if (placeholder) {
        placeholder.innerHTML = `
            <div style="text-align: center;">
                <div style="font-size: 14px; margin-bottom: 8px;">Sistem Hazırlanıyor...</div>
                <div id="rc-load-progress" style="font-size: 12px; opacity: 0.7;">0 / 5 video</div>
            </div>
        `;
    }

    // Progress callback
    const onProgress = (state, loaded, total) => {
        rcLog(`RAM'e yüklendi: ${state} (${loaded}/${total})`, 'info');
        const progressEl = document.getElementById('rc-load-progress');
        if (progressEl) {
            progressEl.textContent = `${loaded} / ${total} video`;
        }
    };

    // Completion callback - assign blob URLs to videos
    const onComplete = (blobUrls) => {
        rcLog('Tüm videolar RAM\'e yüklendi!', 'success');
        rcWidgetState.videosReady = true;

        // Assign blob URLs to video elements
        Object.entries(blobUrls).forEach(([state, blobUrl]) => {
            const video = document.getElementById(`rc-video-${state}`);
            if (video) {
                video.src = blobUrl;
                video.load();
            }
        });

        // Wait for videos to be ready
        const videos = videoStack.querySelectorAll('video');
        let readyCount = 0;

        videos.forEach(video => {
            const checkReady = () => {
                readyCount++;
                if (readyCount >= videos.length) {
                    // All videos ready - show stack, hide placeholder
                    videoStack.style.display = 'block';
                    if (placeholder) placeholder.style.display = 'none';

                    // Start playing standing video
                    const standingVideo = document.getElementById('rc-video-standing');
                    if (standingVideo) {
                        standingVideo.play().catch(e => console.error('Standing play error:', e));
                    }

                    rcUpdateCurrentStateDisplay('standing');
                    rcLog('Avatar hazır!', 'success');
                }
            };

            if (video.readyState >= 3) {
                checkReady();
            } else {
                video.addEventListener('canplay', checkReady, { once: true });
            }
        });
    };

    // Start blob preloading
    rcAssetLoader.preloadAll(onProgress, onComplete);
}

/**
 * Update current state display text (UI only)
 */
function rcUpdateCurrentStateDisplay(state) {
    // Internal state only - no UI element anymore
    rcWidgetState.currentState = state;
}

/**
 * Update current avatar state from backend
 */
async function rcUpdateCurrentState() {
    try {
        const response = await fetch(`${RC_API_URL}/`);
        const data = await response.json();

        rcUpdateCurrentStateDisplay(data.current_state);
    } catch (error) {
        console.error('Error fetching state:', error);
        rcUpdateCurrentStateDisplay('HATA');
    }
}

/**
 * Change avatar video based on state - Seamless Multi-Video Transition
 * No black screen: target video plays first, then opacity switches
 */
function rcChangeVideo(state) {
    const videoStack = document.getElementById('rc-video-stack');
    if (!videoStack) return;

    // Map states to video IDs
    const stateToId = {
        'standing': 'rc-video-standing',
        'listening': 'rc-video-listening',
        'thinking': 'rc-video-thinking',
        'talking': 'rc-video-talking',
        'writing': 'rc-video-writing'
    };

    const targetId = stateToId[state] || stateToId['standing'];
    const targetVideo = document.getElementById(targetId);

    if (!targetVideo) {
        rcLog(`Video bulunamadı: ${targetId}`, 'error');
        return;
    }

    // If already active, do nothing
    if (targetVideo.classList.contains('active')) {
        rcUpdateCurrentStateDisplay(state);
        return;
    }

    // Get all videos
    const allVideos = videoStack.querySelectorAll('video');

    // Start playing target video first (before showing)
    targetVideo.currentTime = 0;
    const playPromise = targetVideo.play();

    if (playPromise !== undefined) {
        playPromise.then(() => {
            // Video is playing, now switch visibility
            allVideos.forEach(video => {
                if (video.id === targetId) {
                    video.classList.add('active');
                } else {
                    video.classList.remove('active');
                    // Pause and reset non-active videos
                    video.pause();
                    video.currentTime = 0;
                }
            });

            rcUpdateCurrentStateDisplay(state);
            rcLog(`Video geçişi: ${state}`, 'info');
        }).catch(error => {
            rcLog(`Video oynatma hatası: ${error.message}`, 'error');
            // Still try to switch even if play fails
            allVideos.forEach(video => {
                if (video.id === targetId) {
                    video.classList.add('active');
                } else {
                    video.classList.remove('active');
                }
            });
        });
    } else {
        // Fallback for older browsers
        allVideos.forEach(video => {
            if (video.id === targetId) {
                video.classList.add('active');
                video.play();
            } else {
                video.classList.remove('active');
                video.pause();
            }
        });
        rcUpdateCurrentStateDisplay(state);
    }
}

function rcTypeWriter(element, text, speed = 15) {
    return new Promise((resolve) => {
        let i = 0;
        element.textContent = '';

        const timer = setInterval(() => {
            if (i < text.length) {
                element.textContent += text.charAt(i);
                i++;
            } else {
                clearInterval(timer);
                resolve();
            }
        }, speed);
    });
}

/**
 * Change avatar state
 */
async function rcChangeState(state) {
    rcLog(`${state} durumuna geçiliyor...`, 'info');

    // Önce videoyu değiştir (bu zaten durum metnini güncelleyecek)
    rcChangeVideo(state);

    try {
        const response = await fetch(`${RC_API_URL}/avatar/state/${state}`, {
            method: 'POST'
        });
        const data = await response.json();

        if (data.status === 'success') {
            rcLog(`✅ ${state} durumuna geçildi`, 'success');
            // Durum metni zaten rcChangeVideo() tarafından güncellendi
            // Backend state'ini de kontrol et (opsiyonel)
            rcUpdateCurrentState();
        } else {
            rcLog(`❌ Hata: ${data.error || 'Bilinmeyen hata'}`, 'error');
        }
    } catch (error) {
        rcLog(`❌ Hata: ${error.message}`, 'error');
    }
}

/**
 * Send main chat message to AI
 */
async function rcSendMainChat() {
    const input = document.getElementById('rc-main-chat-input');
    const message = input.value.trim();

    if (!message) {
        rcLog('❌ Lütfen bir mesaj girin', 'error');
        return;
    }

    // 1. Mesaj gönderilmeden önce → LISTENING
    rcChangeVideo('listening');
    rcLog(`👂 Mesaj dinleniyor: "${message}"`, 'info');
    await new Promise(resolve => setTimeout(resolve, 500));

    // 2. API çağrısı yapılırken → THINKING
    rcChangeVideo('thinking');
    rcLog(`🤔 AI düşünüyor...`, 'info');

    try {
        const response = await fetch(`${RC_API_URL}/ai/chat?message=${encodeURIComponent(message)}`, {
            method: 'POST'
        });
        const data = await response.json();

        if (data.status === 'success') {
            rcLog(`✅ AI Yanıt: ${data.ai_response}`, 'success');
            input.value = '';

            // 3. Cevap geldiğinde → TALKING
            rcChangeVideo('talking');

            // Konuşma süresini tahmin et
            const wordCount = data.ai_response.split(/\s+/).length;
            const estimatedDuration = (wordCount / 2.5) * 1000;

            // Konuşma bitince → STANDING
            setTimeout(() => {
                rcChangeVideo('standing');
                rcLog('✅ Konuşma tamamlandı', 'info');
            }, estimatedDuration);

            rcUpdateCurrentState();
        } else {
            rcLog(`❌ Hata: ${data.message || 'Yanıt alınamadı'}`, 'error');
            rcChangeVideo('standing');
        }
    } catch (error) {
        rcLog(`❌ Hata: ${error.message}`, 'error');
        rcChangeVideo('standing');
    }
}

/**
 * Add message to chat history (user-facing)
 * @param {string} sender - 'user' or 'ai'
 * @param {string} text - Message text (can be empty for typewriter effect)
 * @returns {HTMLElement} The message container element
 */
function rcAddChatMessage(sender, text) {
    const chatHistory = document.getElementById('rc-chat-history');
    if (!chatHistory) return null;

    // Create message container
    const messageDiv = document.createElement('div');
    messageDiv.className = `rc-chat-message ${sender}`;

    // Create bubble
    const bubbleDiv = document.createElement('div');
    bubbleDiv.className = 'rc-chat-bubble';

    // Add sender label for AI messages
    if (sender === 'ai') {
        const senderLabel = document.createElement('div');
        senderLabel.className = 'rc-chat-sender';
        senderLabel.textContent = 'Rai';
        bubbleDiv.appendChild(senderLabel);
    }

    // Add message text with class for typewriter targeting
    const textDiv = document.createElement('div');
    textDiv.className = 'rc-message-text';
    textDiv.textContent = text;
    bubbleDiv.appendChild(textDiv);

    messageDiv.appendChild(bubbleDiv);
    chatHistory.appendChild(messageDiv);

    // Auto-scroll to bottom
    chatHistory.scrollTop = chatHistory.scrollHeight;

    return messageDiv;
}

/**
 * Play audio from URL with avatar synchronization
 */
function rcPlayAudio(audioUrl) {
    // Stop any currently playing audio
    if (rcWidgetState.currentAudio) {
        rcWidgetState.currentAudio.pause();
        rcWidgetState.currentAudio = null;
    }

    if (!audioUrl) {
        rcLog('❌ Ses URL\'si bulunamadı', 'error');
        return;
    }

    // Create new audio element
    const audio = new Audio(audioUrl);
    rcWidgetState.currentAudio = audio;

    // Switch to talking state
    rcChangeVideo('talking');
    rcLog('🔊 Ses çalınıyor...', 'info');

    // Play audio
    audio.play().catch(error => {
        rcLog(`❌ Ses oynatma hatası: ${error.message}`, 'error');
        rcChangeVideo('standing');
    });

    // When audio ends, return to standing
    audio.onended = () => {
        rcChangeVideo('standing');
        rcLog('✅ Ses tamamlandı', 'info');
        rcWidgetState.currentAudio = null;
    };

    // Handle errors
    audio.onerror = () => {
        rcLog('❌ Ses yüklenemedi', 'error');
        rcChangeVideo('standing');
        rcWidgetState.currentAudio = null;
    };
}

/**
 * Send chat message to AI
 */
async function rcSendChat() {
    const input = document.getElementById('rc-chat-input');
    const message = input.value.trim();
    const sendBtn = document.getElementById('rc-send-btn');

    if (!message) {
        rcLog('❌ Lütfen bir mesaj girin', 'error');
        return;
    }

    // Add user message to chat
    rcAddChatMessage('user', message);
    input.value = '';

    // Disable button during request
    if (sendBtn) {
        sendBtn.disabled = true;
        sendBtn.style.opacity = '0.5';
    }

    // Avatar state: listening → thinking
    rcChangeVideo('listening');
    rcLog(`👂 Mesaj alındı: "${message}"`, 'info');
    await new Promise(resolve => setTimeout(resolve, 500));

    rcChangeVideo('thinking');
    rcLog(`🤔 AI düşünüyor...`, 'info');

    try {
        const response = await fetch(`${RC_API_URL}/ai/chat?message=${encodeURIComponent(message)}`, {
            method: 'POST'
        });
        const data = await response.json();

        if (data.status === 'success') {
            // Create AI bubble with empty text for typewriter
            const aiBubble = rcAddChatMessage('ai', '');
            const aiTextEl = aiBubble.querySelector('.rc-message-text');

            // Avatar state: writing (metin yazılırken)
            rcChangeVideo('writing');
            rcLog(`✍️ AI yazıyor...`, 'info');

            // Wait for typewriter to complete
            await rcTypeWriter(aiTextEl, data.ai_response, 15);

            // Avatar state: standing (yazma bitti)
            rcChangeVideo('standing');
            rcLog('✅ Yanıt tamamlandı', 'success');

            rcUpdateCurrentState();
        } else {
            rcLog(`❌ Hata: ${data.message || 'Yanıt alınamadı'}`, 'error');
            rcChangeVideo('standing');
        }
    } catch (error) {
        rcLog(`❌ Hata: ${error.message}`, 'error');
        rcChangeVideo('standing');
    } finally {
        if (sendBtn) {
            sendBtn.disabled = false;
            sendBtn.style.opacity = '1';
        }
    }
}

/**
 * Make AI speak text
 */
async function rcSpeak() {
    const input = document.getElementById('rc-speak-input');
    const text = input.value.trim();
    const speakBtn = input.nextElementSibling;

    if (!text) {
        rcLog('❌ Lütfen konuşturulacak metni girin', 'error');
        return;
    }

    // Disable button during request
    speakBtn.disabled = true;
    speakBtn.textContent = 'İşleniyor...';

    // 1. Metin gönderilmeden önce → LISTENING
    rcChangeVideo('listening');
    rcLog(`👂 Metin dinleniyor: "${text}"`, 'info');
    await new Promise(resolve => setTimeout(resolve, 500)); // Kısa bir gecikme

    // 2. TTS oluşturulurken → THINKING
    rcChangeVideo('thinking');
    rcLog(`🤔 TTS oluşturuluyor...`, 'info');

    try {
        const response = await fetch(`${RC_API_URL}/ai/speak?text=${encodeURIComponent(text)}`, {
            method: 'POST'
        });
        const data = await response.json();

        if (data.status === 'speaking') {
            rcLog('✅ Konuşma başladı (avatar\'ı izleyin)', 'success');
            input.value = '';

            // 3. Konuşma başladığında → TALKING
            rcChangeVideo('talking');

            // Konuşma süresini tahmin et (yaklaşık: 150 kelime/dakika = 2.5 kelime/saniye)
            const wordCount = text.split(/\s+/).length;
            const estimatedDuration = (wordCount / 2.5) * 1000; // milisaniye

            // Konuşma bitince → STANDING
            setTimeout(() => {
                rcChangeVideo('standing');
                rcLog('✅ Konuşma tamamlandı', 'info');
            }, estimatedDuration);

            rcUpdateCurrentState();
        } else {
            rcLog(`❌ Hata: ${data.message || 'Konuşma başlatılamadı'}`, 'error');
            rcChangeVideo('standing'); // Hata durumunda standing'e dön
        }
    } catch (error) {
        rcLog(`❌ Hata: ${error.message}`, 'error');
        rcChangeVideo('standing'); // Hata durumunda standing'e dön
    } finally {
        speakBtn.disabled = false;
        speakBtn.textContent = 'Konuştur';
    }
}

/**
 * Process voice input
 */
async function rcProcessVoice() {
    const fileInput = document.getElementById('rc-voice-file');
    const file = fileInput.files[0];

    if (!file) {
        rcLog('❌ Lütfen bir ses dosyası seçin', 'error');
        return;
    }

    // 1. Ses dosyası seçildiğinde → LISTENING
    rcChangeVideo('listening');
    rcLog(`👂 Ses dosyası dinleniyor: ${file.name}`, 'info');
    await new Promise(resolve => setTimeout(resolve, 500)); // Kısa bir gecikme

    // 2. STT işlenirken → THINKING
    rcChangeVideo('thinking');
    rcLog(`🤔 Ses metne çevriliyor...`, 'info');

    try {
        const formData = new FormData();
        formData.append('audio', file);

        const response = await fetch(`${RC_API_URL}/ai/voice`, {
            method: 'POST',
            body: formData
        });
        const data = await response.json();

        if (data.status === 'processing') {
            rcLog('✅ Ses işleniyor... Avatar\'ı izleyin (Listening → Thinking → Talking)', 'success');

            // Backend'de zaten state değişiklikleri yapılıyor ama widget'ta da güncelleyelim
            // Backend'den response geldiğinde TALKING'e geçecek
            // Burada sadece bekleme süresi tahmin ediyoruz
            setTimeout(() => {
                rcChangeVideo('talking');
                // Konuşma süresini tahmin etmek zor, genel bir süre kullan
                setTimeout(() => {
                    rcChangeVideo('standing');
                    rcLog('✅ İşlem tamamlandı', 'info');
                }, 5000); // 5 saniye sonra standing'e dön
            }, 2000); // 2 saniye sonra talking'e geç

            rcUpdateCurrentState();

            // Clear file input
            fileInput.value = '';
        } else {
            rcLog(`❌ Hata: ${data.message || 'Ses işlenemedi'}`, 'error');
            rcChangeVideo('standing'); // Hata durumunda standing'e dön
        }
    } catch (error) {
        rcLog(`❌ Hata: ${error.message}`, 'error');
        rcChangeVideo('standing'); // Hata durumunda standing'e dön
    }
}

/**
 * Analyze audio volume for silence detection
 */
function rcAnalyzeVolume() {
    if (!rcWidgetState.isAnalyzing || !rcWidgetState.analyser) return;

    const dataArray = new Uint8Array(rcWidgetState.analyser.frequencyBinCount);
    rcWidgetState.analyser.getByteFrequencyData(dataArray);

    // Calculate average volume
    const average = dataArray.reduce((sum, value) => sum + value, 0) / dataArray.length;
    const normalizedVolume = average / 255; // Normalize to 0-1

    // Check if volume is above threshold (user is speaking)
    if (normalizedVolume > rcWidgetState.volumeThreshold) {
        // User is speaking, reset silence timer
        if (rcWidgetState.silenceTimer) {
            clearTimeout(rcWidgetState.silenceTimer);
            rcWidgetState.silenceTimer = null;
        }
    } else {
        // Silence detected, start timer if not already started
        if (!rcWidgetState.silenceTimer && rcWidgetState.isRecording) {
            rcWidgetState.silenceTimer = setTimeout(() => {
                if (rcWidgetState.isRecording) {
                    rcLog('🔇 Sessizlik algılandı, kayıt durduruluyor...', 'info');
                    rcStopRecording();
                }
            }, rcWidgetState.silenceTimeout);
        }
    }

    // Continue analyzing
    if (rcWidgetState.isAnalyzing) {
        requestAnimationFrame(rcAnalyzeVolume);
    }
}

/**
 * Toggle microphone recording (start/stop)
 */
async function rcToggleMicRecording() {
    if (rcWidgetState.isRecording) {
        await rcStopRecording();
    } else {
        await rcStartRecording();
    }
}

/**
 * Start recording from microphone
 */
async function rcStartRecording() {
    const micBtn = document.getElementById('rc-mic-btn');

    if (!micBtn) {
        rcLog('❌ Mikrofon butonu bulunamadı', 'error');
        return;
    }

    try {
        // Check if MediaRecorder is supported
        if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
            throw new Error('Tarayıcınız mikrofon kaydını desteklemiyor');
        }

        // Request microphone permission
        rcLog('🎤 Mikrofon izni isteniyor...', 'info');
        const stream = await navigator.mediaDevices.getUserMedia({ audio: true });

        // Create AudioContext and AnalyserNode for silence detection
        rcWidgetState.audioContext = new (window.AudioContext || window.webkitAudioContext)();
        const source = rcWidgetState.audioContext.createMediaStreamSource(stream);
        rcWidgetState.analyser = rcWidgetState.audioContext.createAnalyser();
        rcWidgetState.analyser.fftSize = 2048;
        rcWidgetState.analyser.smoothingTimeConstant = 0.8;
        source.connect(rcWidgetState.analyser);

        // Create MediaRecorder
        rcWidgetState.mediaRecorder = new MediaRecorder(stream);
        rcWidgetState.audioChunks = [];

        // Collect audio data chunks
        rcWidgetState.mediaRecorder.ondataavailable = (event) => {
            if (event.data.size > 0) {
                rcWidgetState.audioChunks.push(event.data);
            }
        };

        // Handle recording stop
        rcWidgetState.mediaRecorder.onstop = async () => {
            // Create audio blob
            const audioBlob = new Blob(rcWidgetState.audioChunks, { type: 'audio/webm' });
            await rcSendRecordedAudio(audioBlob);

            // Stop all tracks to release microphone
            stream.getTracks().forEach(track => track.stop());
        };

        // Start recording
        rcWidgetState.mediaRecorder.start();
        rcWidgetState.isRecording = true;
        rcWidgetState.isAnalyzing = true;

        // Start volume analysis for silence detection
        rcAnalyzeVolume();

        // Update UI
        micBtn.classList.add('recording');

        // Change avatar to listening state
        rcChangeVideo('listening');
        rcLog('🎤 Mikrofon kaydı başladı (otomatik sessizlik algılama aktif)', 'success');

    } catch (error) {
        rcLog(`❌ Mikrofon hatası: ${error.message}`, 'error');

        // Handle specific error types
        if (error.name === 'NotAllowedError') {
            alert('Mikrofon erişimi reddedildi. Lütfen tarayıcı ayarlarından mikrofon iznini kontrol edin.');
        } else if (error.name === 'NotFoundError') {
            alert('Mikrofon bulunamadı. Lütfen bir mikrofon bağlı olduğundan emin olun.');
        } else {
            alert(`Mikrofon hatası: ${error.message}`);
        }
    }
}

/**
 * Stop microphone recording
 */
async function rcStopRecording() {
    const micBtn = document.getElementById('rc-mic-btn');

    if (!micBtn) return;

    // Prevent multiple calls
    if (!rcWidgetState.isRecording || !rcWidgetState.mediaRecorder) return;

    // Stop recording (this will trigger onstop event)
    rcWidgetState.mediaRecorder.stop();
    rcWidgetState.isRecording = false;
    rcWidgetState.isAnalyzing = false;

    // Clear silence timer
    if (rcWidgetState.silenceTimer) {
        clearTimeout(rcWidgetState.silenceTimer);
        rcWidgetState.silenceTimer = null;
    }

    // Close audio context to free resources
    if (rcWidgetState.audioContext) {
        rcWidgetState.audioContext.close();
        rcWidgetState.audioContext = null;
    }
    rcWidgetState.analyser = null;

    // Update UI
    micBtn.classList.remove('recording');

    // Change avatar to thinking state
    rcChangeVideo('thinking');
    rcLog('🎤 Kayıt durduruldu, işleniyor...', 'info');
}

/**
 * Send recorded audio to backend
 */
async function rcSendRecordedAudio(audioBlob) {
    rcLog(`📤 Ses verisi gönderiliyor (${(audioBlob.size / 1024).toFixed(1)} KB)...`, 'info');

    try {
        const formData = new FormData();
        formData.append('audio', audioBlob, 'recording.webm');

        const response = await fetch(`${RC_API_URL}/ai/voice`, {
            method: 'POST',
            body: formData
        });

        const data = await response.json();

        if (data.status === 'success') {
            // Start playing audio immediately
            if (data.audio_url) {
                rcPlayAudioWithTypewriter(data.audio_url, data.stt_text, data.ai_response);
            } else {
                // Fallback if no audio URL - show messages with typewriter anyway
                if (data.stt_text) {
                    const userBubble = rcAddChatMessage('user', '');
                    const userTextEl = userBubble.querySelector('.rc-message-text');
                    await rcTypeWriter(userTextEl, data.stt_text);
                    rcLog(`🎤 Konuşma metni: "${data.stt_text}"`, 'info');
                }

                if (data.ai_response) {
                    const aiBubble = rcAddChatMessage('ai', '');
                    const aiTextEl = aiBubble.querySelector('.rc-message-text');
                    await rcTypeWriter(aiTextEl, data.ai_response);
                    rcLog(`✅ AI Yanıt alındı`, 'success');
                }

                rcChangeVideo('standing');
            }

            rcUpdateCurrentState();
        } else {
            rcLog(`❌ Hata: ${data.message || 'Ses işlenemedi'}`, 'error');
            rcChangeVideo('standing');
        }
    } catch (error) {
        rcLog(`❌ Hata: ${error.message}`, 'error');
        rcChangeVideo('standing');
    }
}

/**
 * Play audio and show typewriter effect simultaneously
 * @param {string} audioUrl - Audio file URL
 * @param {string} userText - User's spoken text (from STT)
 * @param {string} aiText - AI response text
 */
async function rcPlayAudioWithTypewriter(audioUrl, userText, aiText) {
    // Stop any currently playing audio
    if (rcWidgetState.currentAudio) {
        rcWidgetState.currentAudio.pause();
        rcWidgetState.currentAudio = null;
    }

    if (!audioUrl) {
        rcLog('❌ Ses URL\'si bulunamadı', 'error');
        return;
    }

    // Create new audio element
    const audio = new Audio(audioUrl);
    rcWidgetState.currentAudio = audio;

    // Switch to talking state
    rcChangeVideo('talking');
    rcLog('🔊 Ses çalınıyor...', 'info');

    // Create chat bubbles with empty text (for typewriter)
    let userBubble = null;
    let aiBubble = null;
    let userTextEl = null;
    let aiTextEl = null;

    if (userText) {
        userBubble = rcAddChatMessage('user', '');
        userTextEl = userBubble.querySelector('.rc-message-text');
    }

    if (aiText) {
        aiBubble = rcAddChatMessage('ai', '');
        aiTextEl = aiBubble.querySelector('.rc-message-text');
    }

    // Start audio playback
    audio.play().then(async () => {
        // Audio started - begin typewriter effects simultaneously
        rcLog(`🎤 Konuşma metni yazılıyor...`, 'info');

        // Start both typewriters concurrently
        const typewriterPromises = [];

        if (userTextEl && userText) {
            typewriterPromises.push(rcTypeWriter(userTextEl, userText, 12));
        }

        // Start AI typewriter slightly after user text begins
        if (aiTextEl && aiText) {
            const aiTypewriterPromise = (async () => {
                // Small delay before AI text starts
                await new Promise(resolve => setTimeout(resolve, 200));
                await rcTypeWriter(aiTextEl, aiText, 15);
            })();
            typewriterPromises.push(aiTypewriterPromise);
        }

        // Wait for all typewriters to complete
        await Promise.all(typewriterPromises);
        rcLog(`✅ AI Yanıt alındı`, 'success');

    }).catch(error => {
        rcLog(`❌ Ses oynatma hatası: ${error.message}`, 'error');
        rcChangeVideo('standing');

        // Still show the text even if audio fails
        if (userTextEl && userText) {
            userTextEl.textContent = userText;
        }
        if (aiTextEl && aiText) {
            aiTextEl.textContent = aiText;
        }
    });

    // When audio ends, return to standing
    audio.onended = () => {
        rcChangeVideo('standing');
        rcLog('✅ Ses tamamlandı', 'info');
        rcWidgetState.currentAudio = null;
    };

    // Handle errors
    audio.onerror = () => {
        rcLog('❌ Ses yüklenemedi', 'error');
        rcChangeVideo('standing');
        rcWidgetState.currentAudio = null;

        // Show text even if audio fails
        if (userTextEl && userText) {
            userTextEl.textContent = userText;
        }
        if (aiTextEl && aiText) {
            aiTextEl.textContent = aiText;
        }
    };
}

/**
 * Add log entry to widget log area
 */
function rcLog(message, type = 'info') {
    const logContainer = document.getElementById('rc-log');
    if (!logContainer) return;

    const entry = document.createElement('div');
    entry.className = `rc-widget-log-entry ${type}`;
    entry.textContent = `[${new Date().toLocaleTimeString()}] ${message}`;

    logContainer.appendChild(entry);

    // Keep only last 50 entries
    while (logContainer.children.length > 50) {
        logContainer.removeChild(logContainer.firstChild);
    }

    // Auto scroll to bottom
    logContainer.scrollTop = logContainer.scrollHeight;

    // Also log to console
    console.log(`[RecroTech Widget] ${message}`);
}

// Export functions for potential external use
window.rcWidget = {
    toggle: rcToggleWidget,
    changeState: rcChangeState,
    sendChat: rcSendChat,
    speak: rcSpeak,
    processVoice: rcProcessVoice,
    toggleMicRecording: rcToggleMicRecording,
    startRecording: rcStartRecording,
    stopRecording: rcStopRecording,
    typeWriter: rcTypeWriter,
    playAudioWithTypewriter: rcPlayAudioWithTypewriter,
    log: rcLog
};

