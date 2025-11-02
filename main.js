// --- Configuration ---

const UPLOAD_URL = "http://localhost:8000/speech_to_text"; // Change to your backend route
const MAX_RECORDING_MS = 30_000; // hard cap safety



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


recordBtn.addEventListener("click", startRecording);
stopBtn.addEventListener("click", stopRecording);

async function startRecording() {
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


    mediaRecorder.ondataavailable = (e) => {
      if (e.data && e.data.size) chunks.push(e.data);
    };


    mediaRecorder.onstop = handleStop;


    chunks = [];
    mediaRecorder.start(250); // gather data in chunks


    startedAt = performance.now();
    statusText.textContent = "Recording…";
    recordDialog.showModal();


    startMetersAndSilenceWatch();


    // Hard safety cap
    setTimeout(() => {
      if (mediaRecorder && mediaRecorder.state === "recording") {
        appendLog("Stopped due to max duration cap.");
        stopRecording();
      }
    }, MAX_RECORDING_MS);
  } catch (err) {
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

  console.log('FILE:', file)

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

  // const a = document.createElement('a');
  // a.href = URL.createObjectURL(file);
  // a.download = file.name;
  // document.body.appendChild(a);

  // console.log('a:',a)


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
      console.log('TEXT RESPONSE:', response);
      
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
  try { recordDialog.close(); } catch { }
  cancelAnimationFrame(rafMeter);


  if (silenceTimer) { clearTimeout(silenceTimer); silenceTimer = null; }


  if (audioCtx) {
    try { audioCtx.close(); } catch { }
    audioCtx = null;
  }


  if (mediaStream) {
    mediaStream.getTracks().forEach(t => t.stop());
    mediaStream = null;
  }
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


