// --- Configuration ---

const UPLOAD_URL = "http://localhost:8000/speech_to_text"; // Change to your backend route
const MAX_RECORDING_MS = 20_000; // hard cap safety



// --- DOM ---
const recordBtn = document.getElementById("recordBtn");
const stopBtn = document.getElementById("stopBtn");
const recordDialog = document.getElementById("recordDialog");
const statusText = document.getElementById("statusText");
const meterFill = document.getElementById("meterFill");
const dialogMeterFill = document.getElementById("dialogMeterFill");
const logEl = document.getElementById("log");
const convertedTextEl = document.getElementById("convertedText");
const dbLevel = document.getElementById("dbLevel");


const gainSlider = document.getElementById("gainSlider");
const gainValue = document.getElementById("gainValue");
const silenceSlider = document.getElementById("silenceSlider");
const silenceValue = document.getElementById("silenceValue");
const holdSlider = document.getElementById("holdSlider");  //silence hold duration
const holdValue = document.getElementById("holdValue");

// Timer elements
const timerSeconds = document.getElementById("timerSeconds");
const timerContainer = document.querySelector(".timer-container");
const timerProgress = document.querySelector(".timer-circle-progress");


gainSlider.addEventListener("input", () => (gainValue.textContent = Number(gainSlider.value).toFixed(2)));
silenceSlider.addEventListener("input", () => (silenceValue.textContent = `${silenceSlider.value} dBFS`));
holdSlider.addEventListener("input", () => (holdValue.textContent = `${holdSlider.value} ms`));


// --- State ---
let mediaStream; // raw input (with noiseSuppression/echoCancellation)
let audioCtx; // WebAudio processing graph
let sourceNode, gainNode, hpFilter, analyser, destNode;
let mediaRecorder; // records the processed stream
let chunks = [];
let silenceTimer = null;
let rafMeter; // animation frame handle
let startedAt = 0;
let timerInterval = null; // timer update interval
let maxDurationTimer = null; // hard safety cap timer


recordBtn.addEventListener("click", startRecording);
stopBtn.addEventListener("click", stopRecording);

async function startRecording() {

  console.log('Duration CAP:', MAX_RECORDING_MS)

  try {
    statusText.textContent = "Requesting microphone…";
    mediaStream = await navigator.mediaDevices.getUserMedia({
      audio: {
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true,
        channelCount: 1,
        sampleRate: 48000
      }
    });
    statusText.textContent = "Microphone granted. Initializing…";
    
    // Build processing graph: input -> gain -> highpass -> analyser -> destination
    audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    sourceNode = audioCtx.createMediaStreamSource(mediaStream);

    gainNode = audioCtx.createGain();
    gainNode.gain.value = Number(gainSlider.value);
    gainSlider.oninput = () => (gainNode.gain.value = Number(gainSlider.value));


    hpFilter = audioCtx.createBiquadFilter();
    hpFilter.type = "highpass";
    hpFilter.frequency.value = 80; // roll off low-frequency rumble


    analyser = audioCtx.createAnalyser();
    analyser.fftSize = 1024; // balance responsiveness & smoothing

    destNode = audioCtx.createMediaStreamDestination();


    // Connect graph
    sourceNode.connect(gainNode);
    gainNode.connect(hpFilter);
    hpFilter.connect(analyser);
    analyser.connect(destNode);


    // MediaRecorder will capture from the processed destination stream
    mediaRecorder = new MediaRecorder(destNode.stream, {
      mimeType: pickSupportedMimeType(), // e.g., audio/webm;codecs=opus or audio/ogg;codecs=opus
      audioBitsPerSecond: 128000
    });

    // Add error handler for MediaRecorder
    mediaRecorder.onerror = (event) => {
      console.error("MediaRecorder error:", event.error);
      appendLog(`MediaRecorder error: ${event.error?.message || 'Unknown error'}`);
      // Don't auto-stop on error, let user handle it
    };

    mediaRecorder.ondataavailable = (e) => {
      if (e.data && e.data.size) chunks.push(e.data);
    };

    mediaRecorder.onstop = handleStop;


    chunks = [];
    mediaRecorder.start(250); // gather data in chunks

    // Set startedAt immediately after starting the recorder
    startedAt = performance.now();
    statusText.textContent = "Recording…";
    recordDialog.showModal();

    // Initialize and start timer
    startTimer();

    startMetersAndSilenceWatch();

    // Hard safety cap - check based on actual elapsed time, not just a fixed timeout
    // This ensures it fires at exactly MAX_RECORDING_MS after recording actually started
    maxDurationTimer = setInterval(() => {
      if (!mediaRecorder || mediaRecorder.state !== "recording") {
        clearInterval(maxDurationTimer);
        maxDurationTimer = null;
        return;
      }
      
      const elapsed = performance.now() - startedAt;
      if (elapsed >= MAX_RECORDING_MS) {
        clearInterval(maxDurationTimer);
        maxDurationTimer = null;
        appendLog(`Stopped due to max duration cap (${Math.round(elapsed)}ms elapsed).`);
        stopRecording();
      }
    }, 100); // Check every 100ms for precision
  } 
  catch (err) {
    console.error(err);
    statusText.textContent = `Mic error: ${err?.message || err}`;
    appendLog(`Error: ${err?.message || err}`);
  }
}

function stopRecording() {
  try {
    if (mediaRecorder && mediaRecorder.state === "recording") {
      mediaRecorder.stop();
    }
  } catch (e) {
    console.error(e);
  }
  cleanup();
}

function handleStop() {
  const blob = new Blob(chunks, { type: mediaRecorder.mimeType });
  const file = new File([blob], makeFilename(mediaRecorder.mimeType), { type: mediaRecorder.mimeType });

  //console.log('FILE:', file)

  // Upload using multipart/form-data
  const form = new FormData();
  form.append("file", file);
  form.append("durationMs", String(Math.round(performance.now() - startedAt)));
  form.append("mimeType", mediaRecorder.mimeType);

  


  statusText.textContent = "Uploading…";
  
  // Set up loading indicator with 1 second delay
  let loadingTimer = null;
  let isLoading = false;
  
  loadingTimer = setTimeout(() => {
    isLoading = true;
    convertedTextEl.innerHTML = `
      <div class="loading-container">
        <div class="loading-spinner"></div>
        <span class="loading-text">Converting audio to text...</span>
      </div>
    `;
  }, 1000);


  fetch(UPLOAD_URL, {
    method: "POST",
    body: form,
  })
    .then(async (res) => {
      // Clear loading timer if response came before 1 second
      if (loadingTimer) {
        clearTimeout(loadingTimer);
        loadingTimer = null;
      }
      
      // Clear loading indicator if it was shown
      if (isLoading) {
        isLoading = false;
      }
      
      const response = await res.json();
      //console.log('TEXT RESPONSE:', response);
      
      // Display the converted text
      if (response.text || response.transcript || response.result) {
        const convertedText = response.text || response.transcript || response.result;
        convertedTextEl.textContent = convertedText;
        convertedTextEl.style.color = 'var(--text)';
      } else {
        convertedTextEl.textContent = 'No text found in response';
        convertedTextEl.style.color = 'var(--muted)';
      }
      
      appendLog(`Upload status: ${res.status}\n${JSON.stringify(response)}`);
      statusText.textContent = res.ok ? "Uploaded ✔" : `Upload failed (${res.status})`;
    })
    .catch((err) => {
      // Clear loading timer if there was an error
      if (loadingTimer) {
        clearTimeout(loadingTimer);
        loadingTimer = null;
      }
      
      convertedTextEl.textContent = 'Error converting audio to text';
      convertedTextEl.style.color = '#d32f2f';
      appendLog(`Upload error: ${err?.message || err}`);
      statusText.textContent = `Upload error`;
    });
}

function cleanup() {
  // Stop timer first to prevent any interference
  if (timerInterval) {
    clearInterval(timerInterval);
    timerInterval = null;
  }
  
  // Clear max duration timer
  if (maxDurationTimer) {
    clearInterval(maxDurationTimer);
    maxDurationTimer = null;
  }
  
  cancelAnimationFrame(rafMeter);

  if (silenceTimer) { 
    clearTimeout(silenceTimer); 
    silenceTimer = null; 
  }

  // Close dialog
  try { 
    if (recordDialog && recordDialog.open) {
      recordDialog.close(); 
    }
  } catch { }

  // Reset timer display
  resetTimer();

  if (audioCtx) {
    try { audioCtx.close(); } catch { }
    audioCtx = null;
  }

  if (mediaStream) {
    mediaStream.getTracks().forEach(t => t.stop());
    mediaStream = null;
  }
}

function startTimer() {
  // Safety check: ensure timer elements exist
  if (!timerSeconds || !timerContainer || !timerProgress) {
    console.warn("Timer elements not found, skipping timer initialization");
    return;
  }
  
  // Ensure startedAt is set and valid
  if (!startedAt || startedAt === 0) {
    console.warn("startedAt not set, cannot start timer");
    return;
  }
  
  const circumference = 2 * Math.PI * 54; // radius is 54
  const maxSeconds = MAX_RECORDING_MS / 1000;
  
  // Reset timer display
  timerSeconds.textContent = Math.floor(maxSeconds);
  timerContainer.classList.remove("warning", "critical");
  timerProgress.style.strokeDashoffset = circumference;

  // Store the initial startedAt value to prevent it from being modified
  const timerStartTime = startedAt;

  // Update timer every 100ms for smooth animation
  timerInterval = setInterval(() => {
    try {
      // Only update if recording is still active
      if (!mediaRecorder) {
        clearInterval(timerInterval);
        timerInterval = null;
        return;
      }
      
      if (mediaRecorder.state !== "recording") {
        clearInterval(timerInterval);
        timerInterval = null;
        return;
      }
      
      // Safety check: ensure timer elements still exist
      if (!timerSeconds || !timerContainer || !timerProgress) {
        clearInterval(timerInterval);
        timerInterval = null;
        return;
      }
      
      // Calculate elapsed time using the stored start time
      const elapsed = performance.now() - timerStartTime;
      const remaining = Math.max(0, MAX_RECORDING_MS - elapsed);
      // Use Math.floor to show actual remaining seconds (not rounded up)
      const remainingSeconds = Math.floor(remaining / 1000);
      
      // Update seconds display (ensure it doesn't go below 0)
      timerSeconds.textContent = Math.max(0, remainingSeconds);
      
      // Calculate progress (0 to 1)
      const progress = Math.min(1, Math.max(0, remaining / MAX_RECORDING_MS));
      const offset = circumference * (1 - progress);
      timerProgress.style.strokeDashoffset = offset;
      
      // Change color and border width based on remaining time
      const remainingPercent = (remaining / MAX_RECORDING_MS) * 100;
      
      if (remainingPercent <= 20) {
        // Critical: less than 20% remaining
        timerContainer.classList.remove("warning");
        timerContainer.classList.add("critical");
      } else if (remainingPercent <= 40) {
        // Warning: less than 40% remaining
        timerContainer.classList.remove("critical");
        timerContainer.classList.add("warning");
      } else {
        // Normal: more than 40% remaining
        timerContainer.classList.remove("warning", "critical");
      }
      
      // Stop timer if time is up (but don't stop recording - the safety cap handles that)
      if (remaining <= 0) {
        clearInterval(timerInterval);
        timerInterval = null;
      }
    } catch (error) {
      // If any error occurs in timer, log it but don't stop recording
      console.error("Timer error:", error);
      clearInterval(timerInterval);
      timerInterval = null;
    }
  }, 100);
}

function resetTimer() {
  // Safety check: ensure timer elements exist
  if (!timerSeconds || !timerContainer || !timerProgress) {
    return;
  }
  
  const circumference = 2 * Math.PI * 54;
  const maxSeconds = MAX_RECORDING_MS / 1000;
  
  timerSeconds.textContent = Math.floor(maxSeconds);
  timerContainer.classList.remove("warning", "critical");
  timerProgress.style.strokeDashoffset = circumference;
}

function startMetersAndSilenceWatch() {
  const dataArray = new Uint8Array(analyser.frequencyBinCount);
  const holdMs = () => Number(holdSlider.value);


  const loop = () => {
    analyser.getByteTimeDomainData(dataArray);


    // Compute RMS in dBFS (more accurate calculation)
    let sum = 0;
    for (let i = 0; i < dataArray.length; i++) {
      const v = (dataArray[i] - 128) / 128; // -1..1
      sum += v * v;
    }
    const rms = Math.sqrt(sum / dataArray.length);
    // More accurate dBFS calculation: 20*log10(rms) where rms is 0-1
    const db = rms > 0 ? 20 * Math.log10(rms) : -96; // -96 dBFS is effectively silence
    // UI meters (0..100%) — map dB [-90..0] to 0..100
    const pct = Math.max(0, Math.min(100, ((db + 90) / 90) * 100));
    meterFill.style.width = `${pct}%`;
    dialogMeterFill.style.width = `${pct}%`;
    
    // Update dB level display
    dbLevel.textContent = `dB: ${db.toFixed(1)}`;


    // Silence detection with proper timer management
    const thresholdDb = Number(silenceSlider.value);
    const isSilent = db < thresholdDb;

    
    // Debug logging (uncomment to see what's happening)
    // console.log(`dB: ${db.toFixed(1)}, Threshold: ${thresholdDb}, Silent: ${isSilent}`);
    
    if (!isSilent) {
      // Sound detected - reset the silence timer
      if (silenceTimer) {
        clearTimeout(silenceTimer);
        silenceTimer = null;
        // Uncomment for debug: console.log('Sound detected - resetting silence timer');
      }
    } else {
      // Silence detected - start timer if not already running
      if (!silenceTimer) {
        silenceTimer = setTimeout(() => {
          appendLog(`Auto-stopping after ${holdMs()}ms of silence (db=${db.toFixed(1)}, threshold=${thresholdDb})`);
          stopRecording();
        }, holdMs());
        // Uncomment for debug: console.log(`Silence detected - starting ${holdMs()}ms timer`);
      }
    }

    
    rafMeter = requestAnimationFrame(loop);
  };
  rafMeter = requestAnimationFrame(loop);
}

function pickSupportedMimeType() {
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

function makeFilename(mime) {
  const ext = mime.includes("ogg") ? "ogg" : "webm";
  const ts = new Date().toISOString().replace(/[:.]/g, "-");
  return `recording-${ts}.${ext}`;
}


function appendLog(msg) {
  const time = new Date().toLocaleTimeString();
  logEl.textContent = `[${time}] ${msg}\n` + logEl.textContent;
}


// Feature checks
if (!navigator.mediaDevices?.getUserMedia) {
  statusText.textContent = "getUserMedia not supported in this browser.";
  recordBtn.disabled = true;
}
if (!window.MediaRecorder) {
  appendLog("Warning: MediaRecorder not supported; consider a fallback/encoder.");
}