// audioToTextRecorder.js
// Reusable audio → text recorder for the browser

export class AudioToTextRecorder {
    constructor(options = {}) {
      // ---- Config ----
      this.uploadUrl = options.uploadUrl ?? "http://localhost:8000/speech_to_text";
      this.maxRecordingMs = options.maxRecordingMs ?? 20_000;
  
      this.autoCalibrate = options.autoCalibrate ?? true;
      this.autoCalibrateDurationMs = options.autoCalibrateDurationMs ?? 1000;
      this.autoCalibrateMarginDb = options.autoCalibrateMarginDb ?? 7;
  
      this.silenceThresholdDb = options.silenceThresholdDb ?? -40; // default if no slider
      this.silenceHoldMs = options.silenceHoldMs ?? 1200;
  
      this.audioConstraints = options.audioConstraints ?? {
        audio: {
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true,
          channelCount: 1,
          sampleRate: 48000
        }
      };
  
      // ---- Callbacks (for UI) ----
      this.onStatus = options.onStatus ?? (() => {});
      this.onLog = options.onLog ?? (() => {});
      this.onError = options.onError ?? (() => {});
      this.onLevel = options.onLevel ?? (() => {}); // ({ db, meterPercent }) => {}
      this.onTranscript = options.onTranscript ?? (() => {}); // (text, rawResponse) => {}
  
      // ---- Internal state ----
      this.mediaStream = null;
      this.audioCtx = null;
      this.sourceNode = null;
      this.gainNode = null;
      this.hpFilter = null;
      this.analyser = null;
      this.destNode = null;
      this.mediaRecorder = null;
      this.chunks = [];
      this.silenceTimer = null;
      this.rafMeter = null;
      this.startedAt = 0;
      this.maxDurationTimer = null;
    }
  
    // Public API: start recording
    async start() {
      if (this.mediaRecorder && this.mediaRecorder.state === "recording") {
        this._log("Already recording; ignoring start()");
        return;
      }
  
      try {
        this.onStatus("Requesting microphone…");
        this.mediaStream = await navigator.mediaDevices.getUserMedia(this.audioConstraints);
        this.onStatus("Microphone granted. Initializing…");
  
        // Build Web Audio graph
        this.audioCtx = new (window.AudioContext || window.webkitAudioContext)();
        this.sourceNode = this.audioCtx.createMediaStreamSource(this.mediaStream);
  
        // Gain
        this.gainNode = this.audioCtx.createGain();
        this.gainNode.gain.value = 1.0; // user can control externally if needed
  
        // High-pass filter
        this.hpFilter = this.audioCtx.createBiquadFilter();
        this.hpFilter.type = "highpass";
        this.hpFilter.frequency.value = 80;
  
        // Analyser
        this.analyser = this.audioCtx.createAnalyser();
        this.analyser.fftSize = 1024;
  
        // Destination node – MediaRecorder will record from here
        this.destNode = this.audioCtx.createMediaStreamDestination();
  
        // Connect graph: mic → gain → hp → analyser → dest
        this.sourceNode.connect(this.gainNode);
        this.gainNode.connect(this.hpFilter);
        this.hpFilter.connect(this.analyser);
        this.analyser.connect(this.destNode);
  
        await this.audioCtx.resume();
  
        // Optional auto-calibration for silence threshold
        if (this.autoCalibrate) {
          await this._autoCalibrateSilenceThreshold(
            this.autoCalibrateDurationMs,
            this.autoCalibrateMarginDb
          );
        }
  
        // Setup MediaRecorder
        const stream = this.destNode.stream;
        this.mediaRecorder = new MediaRecorder(stream, {
          mimeType: this._pickSupportedMimeType(),
          audioBitsPerSecond: 128000
        });
  
        this.mediaRecorder.ondataavailable = (e) => {
          if (e.data && e.data.size) this.chunks.push(e.data);
        };
  
        this.mediaRecorder.onerror = (event) => {
          const err = event.error || new Error("Unknown MediaRecorder error");
          this._log(`MediaRecorder error: ${err.message}`);
          this.onError(err);
        };
  
        this.mediaRecorder.onstop = () => this._handleStop();
  
        this.chunks = [];
        this.mediaRecorder.start(250);
        this.startedAt = performance.now();
        this.onStatus("Recording…");
        this._log("Recording started.");
  
        // Start level meter + silence detection
        this._startMetersAndSilenceWatch();
  
        // Safety cap on duration
        this._startMaxDurationWatch();
      } catch (err) {
        this._log(`Mic error: ${err?.message || err}`);
        this.onStatus(`Mic error: ${err?.message || err}`);
        this.onError(err);
        this._cleanup();
      }
    }
  
    // Public API: stop recording
    stop() {
      try {
        if (this.mediaRecorder && this.mediaRecorder.state === "recording") {
          this.mediaRecorder.stop();
        } else {
          this._cleanup();
        }
      } catch (e) {
        this.onError(e);
        this._cleanup();
      }
    }
  
    // Public API: destroy everything
    destroy() {
      this.stop();
      this._cleanup();
    }
  
    // ---- Internals ----
  
    _startMaxDurationWatch() {
      if (this.maxDurationTimer) {
        clearInterval(this.maxDurationTimer);
      }
      this.maxDurationTimer = setInterval(() => {
        if (!this.mediaRecorder || this.mediaRecorder.state !== "recording") {
          clearInterval(this.maxDurationTimer);
          this.maxDurationTimer = null;
          return;
        }
        const elapsed = performance.now() - this.startedAt;
        if (elapsed >= this.maxRecordingMs) {
          clearInterval(this.maxDurationTimer);
          this.maxDurationTimer = null;
          this._log(`Stopping due to max duration (${Math.round(elapsed)}ms).`);
          this.stop();
        }
      }, 100);
    }
  
    async _autoCalibrateSilenceThreshold(durationMs = 1000, marginDb = 7) {
      if (!this.analyser) {
        this._log("autoCalibrateSilenceThreshold: analyser not ready");
        return;
      }
  
      const dataArray = new Uint8Array(this.analyser.frequencyBinCount);
      const samples = [];
      const start = performance.now();
  
      const sampleOnce = (resolve) => {
        this.analyser.getByteTimeDomainData(dataArray);
  
        let sum = 0;
        for (let i = 0; i < dataArray.length; i++) {
          const v = (dataArray[i] - 128) / 128;
          sum += v * v;
        }
        const rms = Math.sqrt(sum / dataArray.length);
        const db = rms > 0 ? 20 * Math.log10(rms) : -96;
        samples.push(db);
  
        if (performance.now() - start < durationMs) {
          requestAnimationFrame(() => sampleOnce(resolve));
        } else {
          if (!samples.length) {
            this._log("autoCalibrateSilenceThreshold: no samples collected");
            return resolve();
          }
          samples.sort((a, b) => a - b);
          const medianNoiseDb = samples[Math.floor(samples.length / 2)];
          let thresholdDb = medianNoiseDb + marginDb;
          thresholdDb = Math.min(-5, thresholdDb); // don't go too close to 0 dBFS
  
          this.silenceThresholdDb = thresholdDb;
          this._log(
            `Auto-calibrated noise floor ≈ ${medianNoiseDb.toFixed(
              1
            )} dBFS, silence threshold set to ${thresholdDb.toFixed(1)} dBFS`
          );
          resolve();
        }
      };
  
      return new Promise((resolve) => sampleOnce(resolve));
    }
  
    _startMetersAndSilenceWatch() {
      if (!this.analyser) return;
  
      const dataArray = new Uint8Array(this.analyser.frequencyBinCount);
      const holdMs = () => this.silenceHoldMs;
  
      const loop = () => {
        if (!this.analyser) return; // in case cleanup happened
  
        this.analyser.getByteTimeDomainData(dataArray);
  
        let sum = 0;
        for (let i = 0; i < dataArray.length; i++) {
          const v = (dataArray[i] - 128) / 128;
          sum += v * v;
        }
        const rms = Math.sqrt(sum / dataArray.length);
        const db = rms > 0 ? 20 * Math.log10(rms) : -96;
  
        // Map [-90..0] dB to [0..100] for UI
        const pct = Math.max(0, Math.min(100, ((db + 90) / 90) * 100));
        this.onLevel({ db, meterPercent: pct });
  
        const thresholdDb = this.silenceThresholdDb;
        const isSilent = db < thresholdDb;
  
        if (!isSilent) {
          if (this.silenceTimer) {
            clearTimeout(this.silenceTimer);
            this.silenceTimer = null;
          }
        } else {
          if (!this.silenceTimer) {
            this.silenceTimer = setTimeout(() => {
              this._log(
                `Auto-stopping after ${holdMs()}ms of silence (db=${db.toFixed(
                  1
                )}, threshold=${thresholdDb})`
              );
              this.stop();
            }, holdMs());
          }
        }
  
        this.rafMeter = requestAnimationFrame(loop);
      };
  
      this.rafMeter = requestAnimationFrame(loop);
    }
  
    async _handleStop() {
      const elapsed = performance.now() - this.startedAt;
      this._log(`Recorder stopped after ${Math.round(elapsed)}ms.`);
      this.onStatus("Processing audio…");
  
      const blob = new Blob(this.chunks, { type: this.mediaRecorder.mimeType });
      const file = new File(
        [blob],
        this._makeFilename(this.mediaRecorder.mimeType),
        { type: this.mediaRecorder.mimeType }
      );
  
      // If no upload URL, just return blob via callback and bail
      if (!this.uploadUrl) {
        this.onTranscript("", { file, blob });
        this._cleanup();
        return;
      }
  
      // Upload to backend
      const form = new FormData();
      form.append("file", file);
      form.append("durationMs", String(Math.round(elapsed)));
      form.append("mimeType", this.mediaRecorder.mimeType);
  
      try {
        const res = await fetch(this.uploadUrl, {
          method: "POST",
          body: form
        });
        const response = await res.json();
  
        const convertedText =
          response.text || response.transcript || response.result || "";
  
        if (convertedText) {
          this.onTranscript(convertedText, response);
        } else {
          this._log("No text field in response.");
          this.onTranscript("", response);
        }
  
        this.onStatus(res.ok ? "Uploaded ✔" : `Upload failed (${res.status})`);
        this._log(`Upload status: ${res.status}`);
      } catch (err) {
        this.onStatus("Upload error");
        this._log(`Upload error: ${err?.message || err}`);
        this.onError(err);
      } finally {
        this._cleanup();
      }
    }
  
    _cleanup() {
      if (this.maxDurationTimer) {
        clearInterval(this.maxDurationTimer);
        this.maxDurationTimer = null;
      }
  
      if (this.rafMeter) {
        cancelAnimationFrame(this.rafMeter);
        this.rafMeter = null;
      }
  
      if (this.silenceTimer) {
        clearTimeout(this.silenceTimer);
        this.silenceTimer = null;
      }
  
      if (this.audioCtx) {
        try {
          this.audioCtx.close();
        } catch {}
        this.audioCtx = null;
      }
  
      if (this.mediaStream) {
        this.mediaStream.getTracks().forEach((t) => t.stop());
        this.mediaStream = null;
      }
  
      this.mediaRecorder = null;
      this.chunks = [];
    }
  
    _pickSupportedMimeType() {
      const types = [
        "audio/webm;codecs=opus",
        "audio/webm",
        "audio/ogg;codecs=opus",
        "audio/ogg"
      ];
      for (const t of types) {
        if (MediaRecorder.isTypeSupported(t)) return t;
      }
      return "audio/webm";
    }
  
    _makeFilename(mime) {
      const ext = mime.includes("ogg") ? "ogg" : "webm";
      const ts = new Date().toISOString().replace(/[:.]/g, "-");
      return `recording-${ts}.${ext}`;
    }
  
    _log(msg) {
      this.onLog(msg);
    }
  
    // Optional: allow external gain control
    setGain(value) {
      if (this.gainNode) {
        this.gainNode.gain.value = Number(value);
      }
    }
  
    setSilenceThresholdDb(db) {
      this.silenceThresholdDb = Number(db);
    }
  
    setSilenceHoldMs(ms) {
      this.silenceHoldMs = Number(ms);
    }
  }
  