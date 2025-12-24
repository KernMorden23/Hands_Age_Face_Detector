import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { Database } from './db.js';

// --- DOM ELEMENTS ---
const statusEl = document.getElementById('status');
const terminalContent = document.getElementById('terminal-content');
const hudContainer = document.getElementById('hud-container');
const vitalsPanel = document.getElementById('vitals-panel');
const bpmEl = document.getElementById('bpm-val');
const o2El = document.getElementById('o2-val');
const stressEl = document.getElementById('stress-val');
const ecgCanvas = document.getElementById('ecg-canvas');
const ecgCtx = ecgCanvas.getContext('2d');
const recBtn = document.getElementById('rec-btn');
const modal = document.getElementById('reg-modal');
const nameInput = document.getElementById('subject-name');
const consentCheck = document.getElementById('consent-check');
const saveBtn = document.getElementById('save-btn');
const cancelBtn = document.getElementById('cancel-btn');
const startOverlay = document.getElementById('start-overlay');
const lightBtn = document.getElementById('light-btn');
const illuminator = document.getElementById('illuminator');
const video = document.getElementById('input-video');
const canvasElement = document.getElementById('output-canvas');
const canvasCtx = canvasElement.getContext('2d');

// --- FINGERPRINT UI ---
const fingerScanner = document.getElementById('finger-scanner');
const fingerStatus = document.getElementById('finger-status');
const scanBeam = document.querySelector('.scan-beam');
const fingerCanvas = document.getElementById('finger-canvas');
const fingerCtx = fingerCanvas.getContext('2d');

// --- CONFIG ---
const TOTAL_PARTICLES = 40000;
const LERP_FACTOR = 0.08; 
const FINGER_BONES = [[0,1],[1,2],[2,3],[3,4],[0,5],[5,6],[6,7],[7,8],[0,9],[9,10],[10,11],[11,12],[0,13],[13,14],[14,15],[15,16],[0,17],[17,18],[18,19],[19,20]];
const PALM_TRIANGLES = [[0, 5, 9], [0, 9, 13], [0, 13, 17]];
const FINGERTIPS = [4, 8, 12, 16, 20];

// --- STATE ---
let knownFaces = Database.getAll();
let faceMatcher = null;
let currentFaceDescriptor = null;
let activeColor = { hex: '#00ffff' };
let currentBPM = 75;
let lastSpokenID = ""; 
let isScanning = false;
let lightMode = false;
let lastFaceMeshResults = null;

// Fingerprint State
let scanTimer = 0;
let isFingerLocked = false;
let isVerified = false; 

// --- AUDIO ---
let audioCtx = null;
let audioEnabled = false;

const SoundFX = {
    playTone: (freq, type, duration, vol=0.1) => {
        if (!audioEnabled || !audioCtx) return; 
        if(audioCtx.state === 'suspended') audioCtx.resume();
        const osc = audioCtx.createOscillator();
        const gain = audioCtx.createGain();
        osc.type = type; 
        osc.frequency.setValueAtTime(freq, audioCtx.currentTime);
        gain.gain.setValueAtTime(vol, audioCtx.currentTime);
        gain.gain.exponentialRampToValueAtTime(0.01, audioCtx.currentTime + duration);
        osc.connect(gain); gain.connect(audioCtx.destination);
        osc.start(); osc.stop(audioCtx.currentTime + duration);
    },
    scan: () => { SoundFX.playTone(800, 'sine', 0.1, 0.05); }, 
    lock: () => { SoundFX.playTone(1200, 'sine', 0.4, 0.1); SoundFX.playTone(600, 'square', 0.2, 0.05); }, 
    alert: () => { SoundFX.playTone(150, 'sawtooth', 0.3, 0.1); }, 
    process: () => { SoundFX.playTone(2000 + Math.random()*500, 'square', 0.05, 0.01); } 
};

const speak = (text) => {
    if (!audioEnabled) return;
    if (window.speechSynthesis.speaking) return;
    const utterance = new SpeechSynthesisUtterance(text);
    utterance.pitch = 0.8; utterance.rate = 1.1;
    const voices = window.speechSynthesis.getVoices();
    const v = voices.find(v => v.name.includes('Google US English')) || voices[0];
    if(v) utterance.voice = v;
    window.speechSynthesis.speak(utterance);
};

// --- LOGGING ---
const log = (msg) => { statusEl.innerText = msg; };
const sqlLog = (cmd) => {
    if (audioEnabled) SoundFX.process(); 
    const line = document.createElement('div');
    line.className = 'sql-line';
    let html = cmd.replace(/(SELECT|FROM|WHERE|INSERT|INTO|VALUES|CREATE|TABLE|IF|NOT|EXISTS)/g, '<span class="sql-keyword">$1</span>');
    html = html.replace(/('[^']+')/g, '<span class="sql-value">$1</span>');
    line.innerHTML = html;
    terminalContent.appendChild(line);
    if (terminalContent.children.length > 8) terminalContent.removeChild(terminalContent.firstChild);
};

// --- SCENE ---
const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(75, window.innerWidth / window.innerHeight, 0.1, 1000);
camera.position.z = 35;
const renderer = new THREE.WebGLRenderer({ antialias: true, preserveDrawingBuffer: true, alpha: true });
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.setClearColor(0x000000, 0); 
document.getElementById('container').appendChild(renderer.domElement);
const controls = new OrbitControls(camera, renderer.domElement);
controls.enableDamping = true;

const gridHelper = new THREE.GridHelper(200, 50, 0x004444, 0x001111);
gridHelper.position.y = -15;
scene.add(gridHelper);

const geometry = new THREE.BufferGeometry();
const positions = new Float32Array(TOTAL_PARTICLES * 3);
const targetPositions = new Float32Array(TOTAL_PARTICLES * 3);
const randoms = new Float32Array(TOTAL_PARTICLES * 3);
const visibility = new Float32Array(TOTAL_PARTICLES);
const targetVisibility = new Float32Array(TOTAL_PARTICLES);

for (let i = 0; i < TOTAL_PARTICLES; i++) {
    positions[i*3] = (Math.random()-0.5)*100; positions[i*3+1] = (Math.random()-0.5)*100; positions[i*3+2] = (Math.random()-0.5)*100;
    targetPositions[i*3]=0; targetPositions[i*3+1]=0; targetPositions[i*3+2]=0;
    randoms[i*3]=Math.random(); randoms[i*3+1]=Math.random(); randoms[i*3+2]=Math.random();
    visibility[i]=0.0; targetVisibility[i]=0.0;
}
geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
geometry.setAttribute('aVisible', new THREE.BufferAttribute(visibility, 1));
geometry.setAttribute('aRandom', new THREE.BufferAttribute(randoms, 3));

const material = new THREE.ShaderMaterial({
    vertexShader: `
        uniform float uTime; uniform vec3 uColor; attribute float aVisible; attribute vec3 aRandom; varying vec3 vColor; varying float vAlpha;
        void main() {
            vec3 pos = position + sin(uTime * 3.0 + aRandom.x * 20.0) * 0.05;
            vec4 mvPosition = modelViewMatrix * vec4(pos, 1.0);
            gl_PointSize = (65.0 * aVisible) / -mvPosition.z;
            gl_Position = projectionMatrix * mvPosition;
            vColor = uColor; vAlpha = aVisible;
        }
    `,
    fragmentShader: `varying float vAlpha; varying vec3 vColor; void main() { if (vAlpha < 0.05) discard; if (distance(gl_PointCoord, vec2(0.5)) > 0.5) discard; gl_FragColor = vec4(vColor, vAlpha); }`,
    uniforms: { uTime: { value: 0 }, uColor: { value: new THREE.Color(0.0, 1.0, 0.8) } },
    transparent: true, depthWrite: false, blending: THREE.AdditiveBlending
});
const particles = new THREE.Points(geometry, material);
scene.add(particles);

// --- AI SETUP ---
const hands = new window.Hands({ locateFile: (file) => `https://cdn.jsdelivr.net/npm/@mediapipe/hands/${file}` });
const faceMesh = new window.FaceMesh({ locateFile: (file) => `https://cdn.jsdelivr.net/npm/@mediapipe/face_mesh/${file}` });
hands.setOptions({ maxNumHands: 2, modelComplexity: 1, minDetectionConfidence: 0.6 });
faceMesh.setOptions({ maxNumFaces: 1, refinerLandmarks: true, minDetectionConfidence: 0.6 });

const mapCoord = (l) => new THREE.Vector3((l.x - 0.5) * -30.0, -(l.y - 0.5) * 30.0, l.z * 30.0);
const lerpVec3 = (v1, v2, a) => new THREE.Vector3().copy(v1).lerp(v2, a);

// --- NEW: GENERATE FINGERPRINT VISUAL ---
function drawDigitalPrint() {
    fingerCtx.clearRect(0, 0, 80, 100);
    fingerCtx.strokeStyle = "#00ffff";
    fingerCtx.lineWidth = 1.5;
    
    // Draw sci-fi rings
    for (let r = 5; r < 40; r += 3) {
        fingerCtx.beginPath();
        let start = Math.random();
        let end = Math.PI * 2 - Math.random();
        fingerCtx.arc(40, 50, r, start, end);
        fingerCtx.stroke();
    }
    
    // Core
    fingerCtx.beginPath();
    fingerCtx.arc(40, 50, 2, 0, Math.PI*2);
    fingerCtx.fillStyle = "#00ffff";
    fingerCtx.fill();
}

function checkFingerprint(landmarks) {
    if(!landmarks || isVerified) return; // Stop checking if verified

    const tip = landmarks[8];
    // Video is mirrored. X: 0.05 to 0.25 | Y: 0.6 to 0.9
    const inBox = (tip.x < 0.25 && tip.x > 0.05 && tip.y > 0.6 && tip.y < 0.9);

    if (inBox) {
        if (!isFingerLocked) {
            isFingerLocked = true;
            fingerScanner.classList.add('active');
            scanBeam.style.animation = 'scan-move 1s infinite linear';
            fingerStatus.innerText = "SCANNING...";
            SoundFX.scan();
        }

        scanTimer++;
        if (scanTimer % 10 === 0) SoundFX.process();

        if (scanTimer > 60) { // Verified!
            isVerified = true;
            fingerStatus.innerText = "MATCH FOUND";
            fingerStatus.style.color = "#00ffff";
            sqlLog("AUTH: BIOMETRIC MATCH [ID:9924-A]");
            SoundFX.lock();
            
            // SHOW THE PRINT
            drawDigitalPrint();
            fingerCanvas.classList.add('revealed');
            
            // Hide beam
            scanBeam.style.opacity = 0;
            scanBeam.style.animation = 'none';

            // Reset after 3 seconds
            setTimeout(() => {
                isVerified = false;
                scanTimer = 0;
                fingerCanvas.classList.remove('revealed');
                fingerStatus.innerText = "PLACE FINGER";
                fingerStatus.style.color = "#00ff88";
                scanBeam.style.opacity = "";
            }, 3000);
        }
    } else {
        isFingerLocked = false;
        scanTimer = 0;
        fingerScanner.classList.remove('active');
        scanBeam.style.animation = 'none';
        fingerStatus.innerText = "PLACE FINGER";
        fingerStatus.style.color = "#00ff88";
    }
}

faceMesh.onResults((results) => { lastFaceMeshResults = results; });

hands.onResults((results) => {
    canvasCtx.save(); canvasCtx.clearRect(0, 0, canvasElement.width, canvasElement.height);
    
    // Draw Face
    if (lastFaceMeshResults && lastFaceMeshResults.multiFaceLandmarks) {
        lastFaceMeshResults.multiFaceLandmarks.forEach(lm => {
            window.drawConnectors(canvasCtx, lm, window.FACEMESH_TESSELATION, {color: '#00FFFF30', lineWidth: 0.5});
            window.drawConnectors(canvasCtx, lm, window.FACEMESH_RIGHT_EYE, {color: activeColor.hex, lineWidth: 1});
            window.drawConnectors(canvasCtx, lm, window.FACEMESH_LEFT_EYE, {color: activeColor.hex, lineWidth: 1});
        });
    }

    // Draw Hands
    if (results.multiHandLandmarks) {
        results.multiHandLandmarks.forEach(lm => window.drawConnectors(canvasCtx, lm, window.HAND_CONNECTIONS, {color: activeColor.hex, lineWidth: 2}));
    }

    // Fingerprint Logic
    if (results.multiHandLandmarks.length > 0) {
        checkFingerprint(results.multiHandLandmarks[0]);
    } else if (!isVerified) {
        isFingerLocked = false;
        fingerScanner.classList.remove('active');
        scanBeam.style.animation = 'none';
    }

    // Particles
    if (results.multiHandLandmarks.length > 0) {
        const pinch = Math.hypot(results.multiHandLandmarks[0][4].x - results.multiHandLandmarks[0][8].x, results.multiHandLandmarks[0][4].y - results.multiHandLandmarks[0][8].y);
        if (pinch < 0.08) { material.uniforms.uColor.value.lerp(new THREE.Color(1.0, 0.2, 0.0), 0.1); activeColor.hex = '#FF3300'; }
        else { material.uniforms.uColor.value.lerp(new THREE.Color(0.0, 1.0, 0.8), 0.1); activeColor.hex = '#00FFFF'; }

        let pIdx = 0;
        const count = results.multiHandLandmarks.length;
        const perHand = Math.floor(TOTAL_PARTICLES / count);

        results.multiHandLandmarks.forEach((lms) => {
            const endIdx = pIdx + perHand;
            FINGER_BONES.forEach(([a, b]) => {
                const vA = mapCoord(lms[a]), vB = mapCoord(lms[b]);
                const limit = Math.floor(perHand * 0.035); 
                for (let j = 0; j < limit; j++) {
                    if (pIdx >= endIdx) break;
                    const p = lerpVec3(vA, vB, Math.random());
                    p.x += (Math.random()-0.5); p.y += (Math.random()-0.5);
                    targetPositions[pIdx*3]=p.x; targetPositions[pIdx*3+1]=p.y; targetPositions[pIdx*3+2]=p.z;
                    targetVisibility[pIdx]=1.0; pIdx++;
                }
            });
            PALM_TRIANGLES.forEach(([a, b, c]) => {
                const vA = mapCoord(lms[a]), vB = mapCoord(lms[b]), vC = mapCoord(lms[c]);
                const limit = Math.floor(perHand * 0.05); 
                for (let j = 0; j < limit; j++) {
                    if (pIdx >= endIdx) break;
                    let r1=Math.random(), r2=Math.random(); if(r1+r2>1){r1=1-r1;r2=1-r2;}
                    const p = new THREE.Vector3().copy(vA).addScaledVector(new THREE.Vector3().subVectors(vB,vA),r1).addScaledVector(new THREE.Vector3().subVectors(vC,vA),r2);
                    p.z += (Math.random()-0.5)*0.5;
                    targetPositions[pIdx*3]=p.x; targetPositions[pIdx*3+1]=p.y; targetPositions[pIdx*3+2]=p.z;
                    targetVisibility[pIdx]=1.0; pIdx++;
                }
            });
            FINGERTIPS.forEach(idx => {
                const vTip = mapCoord(lms[idx]);
                for(let j=0; j<600; j++) {
                     if (pIdx >= endIdx) break;
                     const a = j*2.4, r=0.1*Math.sqrt(j);
                     targetPositions[pIdx*3]=vTip.x+Math.cos(a)*r; targetPositions[pIdx*3+1]=vTip.y+Math.sin(a)*r; targetPositions[pIdx*3+2]=vTip.z;
                     targetVisibility[pIdx]=1.0; pIdx++;
                }
            });
        });
        for(let k=pIdx; k<TOTAL_PARTICLES; k++) targetVisibility[k]=0.0;
    } else { for(let k=0; k<TOTAL_PARTICLES; k++) targetVisibility[k]=0.0; }
    canvasCtx.restore();
});

// --- FACE API ---
async function runBiometrics() {
    if (!video.videoWidth) return;
    const detections = await faceapi.detectAllFaces(video, new faceapi.TinyFaceDetectorOptions()).withFaceLandmarks(true).withFaceDescriptors().withAgeAndGender();
    
    if (!detections.length) { 
        lastSpokenID = ""; hudContainer.innerHTML = ''; vitalsPanel.style.display = 'none'; recBtn.style.display = 'none';
        return; 
    }
    vitalsPanel.style.display = 'block';
    if(Math.random() > 0.8) sqlLog(`SELECT * FROM subjects WHERE descriptor MATCH '${detections[0].descriptor.slice(0,5)}...'`);
    
    hudContainer.innerHTML = '';
    faceapi.resizeResults(detections, { width: 320, height: 240 }).forEach(d => {
        let label = "UNKNOWN", color = "state-unknown";
        if (faceMatcher) {
            const match = faceMatcher.findBestMatch(d.descriptor);
            if (match.label !== 'unknown') { label = match.label; color = "state-locked"; }
        }
        
        if (label !== lastSpokenID) {
            if (label === "UNKNOWN") { speak("Warning. Unauthorized."); SoundFX.alert(); } 
            else { speak("Welcome " + label); SoundFX.lock(); }
            lastSpokenID = label;
        }

        if (label === "UNKNOWN") { 
            currentFaceDescriptor = d.descriptor; recBtn.style.display = 'block'; activeColor.hex = '#FF0055';
        } else { activeColor.hex = '#00FFFF'; }
        
        const el = document.createElement('div'); el.className = `face-label ${color}`;
        el.style.left = `${320-(d.detection.box.x+d.detection.box.width)}px`; el.style.top = `${d.detection.box.y-30}px`;
        el.style.borderColor=activeColor.hex; el.style.color=activeColor.hex;
        el.innerHTML = `ID: ${label}<br>${d.gender.toUpperCase()}/${Math.round(d.age)}`;
        hudContainer.appendChild(el);
    });
}

// --- INIT ---
async function init() {
    log("Loading Neural Networks...");
    const modelUrl = 'https://cdn.jsdelivr.net/npm/@vladmandic/face-api/model/';
    await Promise.all([
        faceapi.nets.tinyFaceDetector.loadFromUri(modelUrl),
        faceapi.nets.faceLandmark68TinyNet.loadFromUri(modelUrl),
        faceapi.nets.faceRecognitionNet.loadFromUri(modelUrl),
        faceapi.nets.ageGenderNet.loadFromUri(modelUrl)
    ]);
    if (knownFaces.length > 0) {
        const validRecords = knownFaces.filter(r => r.descriptor && r.label);
        if (validRecords.length > 0) {
            const labeledDescriptors = validRecords.map(r => new faceapi.LabeledFaceDescriptors(r.label, [new Float32Array(Object.values(r.descriptor))]));
            faceMatcher = new faceapi.FaceMatcher(labeledDescriptors, 0.6);
        }
    }
    const stream = await navigator.mediaDevices.getUserMedia({ video: { width: 320, height: 240 } });
    video.srcObject = stream;
    video.onloadeddata = () => { 
        canvasElement.width=video.videoWidth; canvasElement.height=video.videoHeight; 
        log("Online."); animate(); startAILoop(); 
    };
}

// --- LOOPS ---
const clock = new THREE.Clock();
function animate() {
    material.uniforms.uTime.value = clock.getElapsedTime(); 
    gridHelper.rotation.y += 0.002;
    const pos = geometry.attributes.position.array, vis = geometry.attributes.aVisible.array;
    for(let i=0; i<TOTAL_PARTICLES; i++) {
        pos[i*3] += (targetPositions[i*3] - pos[i*3]) * LERP_FACTOR;
        pos[i*3+1] += (targetPositions[i*3+1] - pos[i*3+1]) * LERP_FACTOR;
        pos[i*3+2] += (targetPositions[i*3+2] - pos[i*3+2]) * LERP_FACTOR;
        vis[i] += (targetVisibility[i] - vis[i]) * 0.08;
    }
    geometry.attributes.position.needsUpdate = true; geometry.attributes.aVisible.needsUpdate = true;
    controls.update(); renderer.render(scene, camera); requestAnimationFrame(animate);
    
    if (vitalsPanel.style.display === 'block') {
        const isLocked = activeColor.hex === '#00FFFF';
        updateHealthMonitor(isLocked);
    }
}

async function startAILoop() {
    while (true) {
        if (video.readyState >= 2 && !isScanning) {
            isScanning = true;
            await hands.send({image: video}); 
            await faceMesh.send({image: video});
            await runBiometrics();
            isScanning = false;
        }
        await new Promise(r => setTimeout(r, 30));
    }
}

let ecgX = 0, lastBeat = 0;
function updateHealthMonitor(isLocked) {
    let desired = isLocked ? 72 : 110; desired += (Math.random() - 0.5) * 5;
    currentBPM += (desired - currentBPM) * 0.05;
    let o2 = isLocked ? 98 + Math.random() : 96 + Math.random();
    bpmEl.innerText = Math.round(currentBPM); o2El.innerText = Math.round(o2) + "%";
    stressEl.innerText = isLocked ? "NORMAL" : "ELEVATED"; stressEl.style.color = isLocked ? "#00ffff" : "#ff0055";
    const speed = currentBPM / 60 * 2;
    ecgCtx.beginPath(); ecgCtx.strokeStyle = isLocked ? "#00ffff" : "#ff0055"; ecgCtx.lineWidth = 2; ecgCtx.moveTo(ecgX, 25);
    let y = 25;
    if (Date.now() - lastBeat > (60000 / currentBPM)) {
        ecgCtx.lineTo(ecgX + 2, 5); ecgCtx.lineTo(ecgX + 4, 45); ecgCtx.lineTo(ecgX + 6, 25);
        lastBeat = Date.now(); ecgX += 6; SoundFX.scan(); 
    } else {
        y += (Math.random() - 0.5) * 3; ecgCtx.lineTo(ecgX + speed, y); ecgX += speed;
    }
    ecgCtx.stroke();
    if (ecgX > ecgCanvas.width) { ecgX = 0; ecgCtx.clearRect(0, 0, ecgCanvas.width, ecgCanvas.height); }
}

recBtn.onclick = () => { if(currentFaceDescriptor) { modal.classList.remove('modal-hidden'); nameInput.focus(); }};
const validate = () => { if(nameInput.value && consentCheck.checked) { saveBtn.disabled=false; saveBtn.classList.add('active'); } else { saveBtn.disabled=true; saveBtn.classList.remove('active'); }};
nameInput.oninput = validate; consentCheck.onchange = validate;
saveBtn.onclick = () => {
    const name = nameInput.value.toUpperCase();
    Database.add(name, currentFaceDescriptor); 
    sqlLog(`INSERT INTO subjects (label, vector) VALUES ('${name}', BLOB)`);
    knownFaces = Database.getAll();
    const labeled = knownFaces.map(r => new faceapi.LabeledFaceDescriptors(r.label, [new Float32Array(Object.values(r.descriptor))]));
    faceMatcher = new faceapi.FaceMatcher(labeled, 0.6);
    modal.classList.add('modal-hidden'); nameInput.value=''; consentCheck.checked=false;
    speak("Saved."); SoundFX.lock(); log(`RECORD CREATED: ${name}`);
};
cancelBtn.onclick = () => modal.classList.add('modal-hidden');

startOverlay.addEventListener('click', () => {
    try {
        if (!audioCtx) audioCtx = new (window.AudioContext || window.webkitAudioContext)();
        audioCtx.resume().then(() => {
            audioEnabled = true; startOverlay.style.opacity = 0;
            setTimeout(() => startOverlay.style.display = 'none', 500);
            SoundFX.lock(); speak("System Online.");
        });
    } catch (e) { console.log(e); }
});

lightBtn.onclick = () => {
    lightMode = !lightMode;
    if(lightMode) {
        illuminator.classList.add('active'); lightBtn.classList.add('active');
        if(audioEnabled) SoundFX.lock();
    } else {
        illuminator.classList.remove('active'); lightBtn.classList.remove('active');
    }
};

window.onresize = () => { camera.aspect=window.innerWidth/window.innerHeight; camera.updateProjectionMatrix(); renderer.setSize(window.innerWidth, window.innerHeight); };

init();