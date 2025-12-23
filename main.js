import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { Pane } from 'tweakpane';

const statusEl = document.getElementById('status');
const hudContainer = document.getElementById('hud-container');
const recBtn = document.getElementById('rec-btn');
const modal = document.getElementById('reg-modal');
const nameInput = document.getElementById('subject-name');
const consentCheck = document.getElementById('consent-check');
const saveBtn = document.getElementById('save-btn');
const cancelBtn = document.getElementById('cancel-btn');
const log = (msg) => { statusEl.innerText = msg; };

// CONFIG
const WORLD_SCALE = 30.0;
const TOTAL_PARTICLES = 35000;
const FINGER_BONES = [
    [0, 1], [1, 2], [2, 3], [3, 4],
    [0, 5], [5, 6], [6, 7], [7, 8],
    [0, 9], [9, 10], [10, 11], [11, 12],
    [0, 13], [13, 14], [14, 15], [15, 16],
    [0, 17], [17, 18], [18, 19], [19, 20]
];
const PALM_TRIANGLES = [[0, 5, 9], [0, 9, 13], [0, 13, 17]];
const FINGERTIPS = [4, 8, 12, 16, 20];

// STATE
let isDisintegrating = false;
let indexFingerTip = new THREE.Vector3(999, 999, 999);
let frameCounter = 0;
let faceMatcher = null;
let currentFaceDescriptor = null;
let knownFaces = JSON.parse(localStorage.getItem('biometricDB')) || [];
let activeColor = { hex: '#00ffff' }; // Track current system color

log(`System Ready. Records: ${knownFaces.length}`);

// THREE.JS
const container = document.getElementById('container');
const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(75, window.innerWidth / window.innerHeight, 0.1, 1000);
camera.position.z = 35;
const renderer = new THREE.WebGLRenderer({ antialias: true, preserveDrawingBuffer: true });
renderer.setSize(window.innerWidth, window.innerHeight);
container.appendChild(renderer.domElement);
const controls = new OrbitControls(camera, renderer.domElement);
controls.enableDamping = true;

const orb = new THREE.Mesh(new THREE.IcosahedronGeometry(3, 2), new THREE.MeshBasicMaterial({ color: 0xaa00ff, wireframe: true, transparent: true, opacity: 0.3 }));
scene.add(orb);
const fadePlane = new THREE.Mesh(new THREE.PlaneGeometry(200, 200), new THREE.MeshBasicMaterial({ color: 0x000000, transparent: true, opacity: 0.15 }));
fadePlane.position.z = -1;
scene.add(fadePlane);

// PARTICLES
const geometry = new THREE.BufferGeometry();
const positions = new Float32Array(TOTAL_PARTICLES * 3);
const targetPositions = new Float32Array(TOTAL_PARTICLES * 3);
const randoms = new Float32Array(TOTAL_PARTICLES * 3);
const visibility = new Float32Array(TOTAL_PARTICLES);
const targetVisibility = new Float32Array(TOTAL_PARTICLES);

for (let i = 0; i < TOTAL_PARTICLES; i++) {
    positions[i*3]=0; positions[i*3+1]=0; positions[i*3+2]=0;
    targetPositions[i*3]=0; targetPositions[i*3+1]=0; targetPositions[i*3+2]=0;
    randoms[i*3]=Math.random(); randoms[i*3+1]=Math.random(); randoms[i*3+2]=Math.random();
    visibility[i]=0.0; targetVisibility[i]=0.0;
}
geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
geometry.setAttribute('aRandom', new THREE.BufferAttribute(randoms, 3));
geometry.setAttribute('aVisible', new THREE.BufferAttribute(visibility, 1));

const material = new THREE.ShaderMaterial({
    vertexShader: `
        uniform float uTime;
        uniform vec3 uColor;
        attribute float aVisible;
        attribute vec3 aRandom;
        varying float vAlpha;
        varying vec3 vColor;
        void main() {
            vec3 pos = position;
            pos += sin(uTime * 5.0 + aRandom.x * 20.0) * 0.05;
            vec4 mvPosition = modelViewMatrix * vec4(pos, 1.0);
            gl_PointSize = (40.0 * aVisible) / -mvPosition.z;
            gl_Position = projectionMatrix * mvPosition;
            vColor = uColor;
            vAlpha = aVisible;
        }
    `,
    fragmentShader: `
        varying float vAlpha;
        varying vec3 vColor;
        void main() {
            if (vAlpha < 0.05) discard;
            vec2 cxy = 2.0 * gl_PointCoord - 1.0;
            if (dot(cxy, cxy) > 1.0) discard;
            gl_FragColor = vec4(vColor, vAlpha);
        }
    `,
    uniforms: { uTime: { value: 0 }, uColor: { value: new THREE.Color(0.0, 1.0, 0.8) } },
    transparent: true, depthWrite: false, blending: THREE.AdditiveBlending
});
const particles = new THREE.Points(geometry, material);
scene.add(particles);

// AI SETUP
const hands = new window.Hands({ locateFile: (file) => `https://cdn.jsdelivr.net/npm/@mediapipe/hands/${file}` });
const faceMesh = new window.FaceMesh({ locateFile: (file) => `https://cdn.jsdelivr.net/npm/@mediapipe/face_mesh/${file}` });
hands.setOptions({ maxNumHands: 2, modelComplexity: 1, minDetectionConfidence: 0.6 });
faceMesh.setOptions({ maxNumFaces: 3, refinerLandmarks: true, minDetectionConfidence: 0.6 });

const mapCoord = (l) => new THREE.Vector3((l.x - 0.5) * -WORLD_SCALE, -(l.y - 0.5) * WORLD_SCALE, l.z * WORLD_SCALE);
const lerpVec3 = (v1, v2, a) => new THREE.Vector3().copy(v1).lerp(v2, a);
const canvasElement = document.getElementById('output-canvas');
const canvasCtx = canvasElement.getContext('2d');

let lastFaceResults = null;

// HAND LOGIC
hands.onResults((results) => {
    // 1. DRAW SKELETON ON WEBCAM
    canvasCtx.save();
    canvasCtx.clearRect(0, 0, canvasElement.width, canvasElement.height);
    
    // Draw Face first (from stored results)
    if (lastFaceResults && lastFaceResults.multiFaceLandmarks) {
        for (const landmarks of lastFaceResults.multiFaceLandmarks) {
            window.drawConnectors(canvasCtx, landmarks, window.FACEMESH_TESSELATION, {color: '#FFFFFF20', lineWidth: 0.5});
            window.drawConnectors(canvasCtx, landmarks, window.FACEMESH_RIGHT_EYE, {color: activeColor.hex, lineWidth: 1});
            window.drawConnectors(canvasCtx, landmarks, window.FACEMESH_LEFT_EYE, {color: activeColor.hex, lineWidth: 1});
        }
    }
    
    // Draw Hands
    if (results.multiHandLandmarks) {
        for (const landmarks of results.multiHandLandmarks) {
            window.drawConnectors(canvasCtx, landmarks, window.HAND_CONNECTIONS, {color: activeColor.hex, lineWidth: 2});
            window.drawLandmarks(canvasCtx, landmarks, {color: '#FFFFFF', lineWidth: 1, radius: 2});
        }
    }

    // 2. PARTICLE SYSTEM
    if (results.multiHandLandmarks.length > 0) {
        const landmarks = results.multiHandLandmarks[0];
        const thumb = landmarks[4];
        const index = landmarks[8];
        const pinch = Math.hypot(thumb.x - index.x, thumb.y - index.y);
        
        // COLOR LOGIC
        if (pinch < 0.08) {
             material.uniforms.uColor.value.lerp(new THREE.Color(1.0, 0.2, 0.0), 0.1);
             activeColor.hex = '#FF3300';
        } else {
             material.uniforms.uColor.value.lerp(new THREE.Color(0.0, 1.0, 0.8), 0.1);
             activeColor.hex = '#00FFFF';
        }
        
        indexFingerTip.copy(mapCoord(index));

        let pIdx = 0;
        const handCount = results.multiHandLandmarks.length;
        const particlesPerHand = Math.floor(TOTAL_PARTICLES / handCount);

        results.multiHandLandmarks.forEach((lms) => {
            const startIdx = pIdx;
            const endIdx = startIdx + particlesPerHand;
            
            // Bones
            for (let i = 0; i < FINGER_BONES.length; i++) {
                const [a, b] = FINGER_BONES[i];
                const vA = mapCoord(lms[a]), vB = mapCoord(lms[b]);
                const limit = Math.floor(particlesPerHand * 0.025);
                for (let j = 0; j < limit; j++) {
                    if (pIdx >= endIdx) break;
                    const point = lerpVec3(vA, vB, Math.random());
                    const r = 0.5; const theta = Math.random()*Math.PI*2;
                    point.x += Math.cos(theta)*r*Math.random();
                    point.y += Math.sin(theta)*r*Math.random();
                    targetPositions[pIdx*3]=point.x; targetPositions[pIdx*3+1]=point.y; targetPositions[pIdx*3+2]=point.z;
                    targetVisibility[pIdx]=1.0; pIdx++;
                }
            }
            // Fingerprints
            for (let i = 0; i < FINGERTIPS.length; i++) {
                const vTip = mapCoord(lms[FINGERTIPS[i]]);
                for (let j = 0; j < 600; j++) {
                    if (pIdx >= endIdx) break;
                    const angle = j * 2.4; const radius = 0.1 * Math.sqrt(j);
                    const p = vTip.clone();
                    p.x += Math.cos(angle)*radius; p.y += Math.sin(angle)*radius; p.z += Math.random()*0.2;
                    targetPositions[pIdx*3]=p.x; targetPositions[pIdx*3+1]=p.y; targetPositions[pIdx*3+2]=p.z;
                    targetVisibility[pIdx]=1.0; pIdx++;
                }
            }
        });
        for (let k = pIdx; k < TOTAL_PARTICLES; k++) targetVisibility[k] = 0.0;
    } else {
        for (let k = 0; k < TOTAL_PARTICLES; k++) targetVisibility[k] = 0.0;
    }
    canvasCtx.restore();
});

faceMesh.onResults((results) => { lastFaceResults = results; });

// INIT
const video = document.getElementById('input-video');
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
        const labeledDescriptors = knownFaces.map(r => new faceapi.LabeledFaceDescriptors(r.label, [new Float32Array(Object.values(r.descriptor))]));
        faceMatcher = new faceapi.FaceMatcher(labeledDescriptors, 0.6);
    }
    startCamera();
}

async function startCamera() {
    const stream = await navigator.mediaDevices.getUserMedia({ video: { width: 320, height: 240 } });
    video.srcObject = stream;
    video.onloadeddata = () => {
        canvasElement.width = video.videoWidth;
        canvasElement.height = video.videoHeight;
        log("Online. Scanning..."); loop(); 
    };
}

async function loop() {
    if (video.readyState >= 2) {
        await hands.send({ image: video });
        await faceMesh.send({ image: video });
        frameCounter++;
        if (frameCounter % 10 === 0) runBiometrics();
    }
    requestAnimationFrame(loop);
}

// BIOMETRICS
async function runBiometrics() {
    const detections = await faceapi.detectAllFaces(video, new faceapi.TinyFaceDetectorOptions()).withFaceLandmarks(true).withFaceDescriptors().withAgeAndGender();
    hudContainer.innerHTML = ''; recBtn.style.display = 'none';

    if (!detections.length) return;
    const resized = faceapi.resizeResults(detections, { width: 320, height: 240 });

    resized.forEach(d => {
        const { age, gender, descriptor } = d;
        const box = d.detection.box;
        let labelText = "UNKNOWN"; let colorClass = "state-unknown";

        if (faceMatcher) {
            const match = faceMatcher.findBestMatch(descriptor);
            if (match.label !== 'unknown') { labelText = match.label; colorClass = "state-locked"; }
        }

        if (labelText === "UNKNOWN") { currentFaceDescriptor = descriptor; recBtn.style.display = 'block'; }

        const label = document.createElement('div');
        label.className = `face-label ${colorClass}`;
        label.style.left = `${320 - (box.x + box.width)}px`;
        label.style.top = `${box.y - 30}px`;
        label.style.borderColor = activeColor.hex; // Match system color
        label.style.color = activeColor.hex;
        label.innerHTML = `ID: ${labelText}<br>${gender.toUpperCase()} / ${Math.round(age)}`;
        hudContainer.appendChild(label);
    });
}

// GUI LOGIC
recBtn.addEventListener('click', () => { if(currentFaceDescriptor) { modal.classList.remove('modal-hidden'); nameInput.focus(); }});
const validate = () => { if(nameInput.value && consentCheck.checked) { saveBtn.disabled=false; saveBtn.classList.add('active'); } else { saveBtn.disabled=true; saveBtn.classList.remove('active'); }};
nameInput.addEventListener('input', validate); consentCheck.addEventListener('change', validate);
saveBtn.addEventListener('click', () => {
    const name = nameInput.value.toUpperCase();
    knownFaces.push({ label: name, descriptor: currentFaceDescriptor });
    localStorage.setItem('biometricDB', JSON.stringify(knownFaces));
    const labeled = knownFaces.map(r => new faceapi.LabeledFaceDescriptors(r.label, [new Float32Array(Object.values(r.descriptor))]));
    faceMatcher = new faceapi.FaceMatcher(labeled, 0.6);
    modal.classList.add('modal-hidden'); nameInput.value = ''; consentCheck.checked = false;
    log(`RECORD CREATED: ${name}`);
});
cancelBtn.addEventListener('click', () => modal.classList.add('modal-hidden'));

// ANIMATION
const clock = new THREE.Clock();
function animate() {
    const time = clock.getElapsedTime();
    material.uniforms.uTime.value = time;
    fadePlane.lookAt(camera.position);

    const pos = geometry.attributes.position.array;
    const vis = geometry.attributes.aVisible.array;
    const target = targetPositions;
    const tVis = targetVisibility;

    // SUPER SMOOTH LERP (0.12 factor)
    for (let i = 0; i < TOTAL_PARTICLES; i++) {
        pos[i*3] += (target[i*3] - pos[i*3]) * 0.12;
        pos[i*3+1] += (target[i*3+1] - pos[i*3+1]) * 0.12;
        pos[i*3+2] += (target[i*3+2] - pos[i*3+2]) * 0.12;
        vis[i] += (tVis[i] - vis[i]) * 0.1;
    }
    geometry.attributes.position.needsUpdate = true;
    geometry.attributes.aVisible.needsUpdate = true;

    controls.update();
    renderer.render(scene, camera);
    requestAnimationFrame(animate);
}
window.addEventListener('resize', () => { camera.aspect=window.innerWidth/window.innerHeight; camera.updateProjectionMatrix(); renderer.setSize(window.innerWidth, window.innerHeight); });

init();
animate();