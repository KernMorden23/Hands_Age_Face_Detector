import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { Pane } from 'tweakpane';

const statusEl = document.getElementById('status');
const hudContainer = document.getElementById('hud-container');
const log = (msg) => { statusEl.innerText = msg; };

const FINGER_BONES = [
    [0, 1], [1, 2], [2, 3], [3, 4],
    [0, 5], [5, 6], [6, 7], [7, 8],
    [0, 9], [9, 10], [10, 11], [11, 12],
    [0, 13], [13, 14], [14, 15], [15, 16],
    [0, 17], [17, 18], [18, 19], [19, 20]
];
const PALM_TRIANGLES = [[0, 5, 9], [0, 9, 13], [0, 13, 17]];
const WORLD_SCALE = 30.0;
const TOTAL_PARTICLES = 25000;

let isDisintegrating = false;
let indexFingerTip = new THREE.Vector3(999, 999, 999);
let frameCounter = 0;

const container = document.getElementById('container');
const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(75, window.innerWidth / window.innerHeight, 0.1, 1000);
camera.position.z = 35;
const renderer = new THREE.WebGLRenderer({ antialias: true, preserveDrawingBuffer: true });
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
renderer.autoClearColor = false; 
container.appendChild(renderer.domElement);
const controls = new OrbitControls(camera, renderer.domElement);
controls.enableDamping = true;

const orbGeo = new THREE.IcosahedronGeometry(3, 1);
const orbMat = new THREE.MeshBasicMaterial({ color: 0xaa00ff, wireframe: true });
const orb = new THREE.Mesh(orbGeo, orbMat);
scene.add(orb);

const fadePlane = new THREE.Mesh(new THREE.PlaneGeometry(200, 200), new THREE.MeshBasicMaterial({ color: 0x000000, transparent: true, opacity: 0.15 }));
fadePlane.position.z = -1;
scene.add(fadePlane);

const geometry = new THREE.BufferGeometry();
const positions = new Float32Array(TOTAL_PARTICLES * 3);
const targetPositions = new Float32Array(TOTAL_PARTICLES * 3);
const randoms = new Float32Array(TOTAL_PARTICLES * 3);
const visibility = new Float32Array(TOTAL_PARTICLES);
const targetVisibility = new Float32Array(TOTAL_PARTICLES);
const velocities = new Float32Array(TOTAL_PARTICLES * 3);

for (let i = 0; i < TOTAL_PARTICLES; i++) {
    positions[i*3]=0; positions[i*3+1]=0; positions[i*3+2]=0;
    targetPositions[i*3]=0; targetPositions[i*3+1]=0; targetPositions[i*3+2]=0;
    randoms[i*3]=Math.random(); randoms[i*3+1]=Math.random(); randoms[i*3+2]=Math.random();
    visibility[i] = 0.0;
    targetVisibility[i] = 0.0;
    velocities[i*3] = (Math.random()-0.5)*0.5;
    velocities[i*3+1] = (Math.random()-0.5)*0.5;
    velocities[i*3+2] = (Math.random()-0.5)*0.5;
}
geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
geometry.setAttribute('aRandom', new THREE.BufferAttribute(randoms, 3));
geometry.setAttribute('aVisible', new THREE.BufferAttribute(visibility, 1));

const material = new THREE.ShaderMaterial({
    vertexShader: `
        uniform float uTime;
        uniform vec3 uColor;
        attribute vec3 aRandom;
        attribute float aVisible;
        varying float vAlpha;
        varying vec3 vColor;
        void main() {
            vec3 pos = position;
            float pulse = sin(uTime * 4.0 + pos.y * 0.2) * 0.5 + 0.5;
            float noise = sin(uTime * 3.0 + aRandom.x * 10.0) * 0.2;
            pos += noise;
            vec4 mvPosition = modelViewMatrix * vec4(pos, 1.0);
            gl_PointSize = (70.0 * aVisible) / -mvPosition.z;
            gl_Position = projectionMatrix * mvPosition;
            vColor = uColor + vec3(pulse * 0.3);
            vAlpha = aVisible * (0.6 + 0.4 * pulse);
        }
    `,
    fragmentShader: `
        varying float vAlpha;
        varying vec3 vColor;
        void main() {
            if (vAlpha < 0.05) discard;
            float d = distance(gl_PointCoord, vec2(0.5));
            if (d > 0.5) discard;
            float strength = pow(1.0 - d * 2.0, 1.5);
            gl_FragColor = vec4(vColor, strength * vAlpha);
        }
    `,
    uniforms: { uTime: { value: 0 }, uColor: { value: new THREE.Color(0.0, 1.0, 1.0) } },
    transparent: true, depthWrite: false, blending: THREE.AdditiveBlending
});
const particles = new THREE.Points(geometry, material);
scene.add(particles);

const Hands = window.Hands;
const FaceMesh = window.FaceMesh;
const hands = new Hands({ locateFile: (file) => `https://cdn.jsdelivr.net/npm/@mediapipe/hands/${file}` });
const faceMesh = new FaceMesh({ locateFile: (file) => `https://cdn.jsdelivr.net/npm/@mediapipe/face_mesh/${file}` });

hands.setOptions({ maxNumHands: 2, modelComplexity: 1, minDetectionConfidence: 0.6, minTrackingConfidence: 0.6 });
faceMesh.setOptions({ maxNumFaces: 3, refinerLandmarks: true, minDetectionConfidence: 0.6, minTrackingConfidence: 0.6 });

const mapCoord = (l) => new THREE.Vector3((l.x - 0.5) * -WORLD_SCALE, -(l.y - 0.5) * WORLD_SCALE, l.z * WORLD_SCALE);
const lerpVec3 = (v1, v2, a) => new THREE.Vector3().copy(v1).lerp(v2, a);
const canvasElement = document.getElementById('output-canvas');
const canvasCtx = canvasElement.getContext('2d');

let lastFaceResults = null;

hands.onResults((results) => {
    const randArr = geometry.attributes.aRandom.array;

    canvasCtx.save();
    canvasCtx.clearRect(0, 0, canvasElement.width, canvasElement.height);

    if (lastFaceResults && lastFaceResults.multiFaceLandmarks) {
        for (const landmarks of lastFaceResults.multiFaceLandmarks) {
            window.drawConnectors(canvasCtx, landmarks, window.FACEMESH_TESSELATION, {color: '#C0C0C070', lineWidth: 1});
            window.drawConnectors(canvasCtx, landmarks, window.FACEMESH_RIGHT_EYE, {color: '#00FFFF', lineWidth: 2});
            window.drawConnectors(canvasCtx, landmarks, window.FACEMESH_LEFT_EYE, {color: '#00FFFF', lineWidth: 2});
            window.drawConnectors(canvasCtx, landmarks, window.FACEMESH_LIPS, {color: '#FF0055', lineWidth: 2});
            window.drawConnectors(canvasCtx, landmarks, window.FACEMESH_FACE_OVAL, {color: '#E0E0E0', lineWidth: 1});
        }
    }

    if (results.multiHandLandmarks && results.multiHandLandmarks.length > 0) {
        const handLandmarks = results.multiHandLandmarks[0];
        const thumb = handLandmarks[4], index = handLandmarks[8];
        const pinch = Math.hypot(thumb.x - index.x, thumb.y - index.y);
        if (pinch < 0.08) material.uniforms.uColor.value.lerp(new THREE.Color(1.0, 0.0, 0.2), 0.1);
        else material.uniforms.uColor.value.lerp(new THREE.Color(0.0, 1.0, 1.0), 0.1);

        indexFingerTip.copy(mapCoord(index));

        let pIdx = 0;
        const handCount = results.multiHandLandmarks.length;
        const particlesPerHand = Math.floor(TOTAL_PARTICLES / handCount);

        results.multiHandLandmarks.forEach((landmarks) => {
            const startIdx = pIdx;
            const endIdx = startIdx + particlesPerHand;
            for (let i = 0; i < FINGER_BONES.length; i++) {
                const [idxA, idxB] = FINGER_BONES[i];
                const vA = mapCoord(landmarks[idxA]), vB = mapCoord(landmarks[idxB]);
                const boneVec = new THREE.Vector3().subVectors(vB, vA);
                const limit = Math.floor(particlesPerHand * 0.04);
                for (let j = 0; j < limit; j++) {
                    if (pIdx >= endIdx || pIdx >= TOTAL_PARTICLES) break;
                    const t = Math.random(); 
                    const point = lerpVec3(vA, vB, t);
                    const theta = randArr[pIdx*3] * Math.PI * 2;
                    const r = 0.6 + randArr[pIdx*3+1] * 0.4;
                    const axis = boneVec.clone().normalize();
                    const tangent = Math.abs(axis.x)>0.9 ? new THREE.Vector3(0,1,0) : new THREE.Vector3(1,0,0);
                    tangent.cross(axis).normalize();
                    const bitangent = new THREE.Vector3().crossVectors(axis, tangent).normalize();
                    point.add(tangent.multiplyScalar(Math.cos(theta)*r)).add(bitangent.multiplyScalar(Math.sin(theta)*r));
                    
                    targetPositions[pIdx*3] = point.x;
                    targetPositions[pIdx*3+1] = point.y;
                    targetPositions[pIdx*3+2] = point.z;
                    targetVisibility[pIdx] = 1.0;
                    pIdx++;
                }
            }
            for (let i = 0; i < PALM_TRIANGLES.length; i++) {
                const [a, b, c] = PALM_TRIANGLES[i];
                const vA = mapCoord(landmarks[a]), vB = mapCoord(landmarks[b]), vC = mapCoord(landmarks[c]);
                const limit = Math.floor(particlesPerHand * 0.05);
                for (let j = 0; j < limit; j++) {
                    if (pIdx >= endIdx || pIdx >= TOTAL_PARTICLES) break;
                    let r1=Math.random(), r2=Math.random();
                    if(r1+r2>1){ r1=1-r1; r2=1-r2; }
                    const p = new THREE.Vector3().copy(vA).addScaledVector(new THREE.Vector3().subVectors(vB,vA),r1).addScaledVector(new THREE.Vector3().subVectors(vC,vA),r2);
                    p.z += (Math.random()-0.5)*0.4;
                    
                    targetPositions[pIdx*3] = p.x;
                    targetPositions[pIdx*3+1] = p.y;
                    targetPositions[pIdx*3+2] = p.z;
                    targetVisibility[pIdx] = 1.0;
                    pIdx++;
                }
            }
            window.drawConnectors(canvasCtx, landmarks, window.HAND_CONNECTIONS, {color: '#00FF00', lineWidth: 2});
        });
        for (let k = pIdx; k < TOTAL_PARTICLES; k++) targetVisibility[k] = 0.0;
    } else {
        for (let k = 0; k < TOTAL_PARTICLES; k++) targetVisibility[k] = 0.0;
    }
    canvasCtx.restore();
});

faceMesh.onResults((results) => {
    lastFaceResults = results;
});

const video = document.getElementById('input-video');
async function init() {
    log("Loading AI Models...");
    const modelUrl = 'https://cdn.jsdelivr.net/npm/@vladmandic/face-api/model/';
    await faceapi.nets.tinyFaceDetector.loadFromUri(modelUrl);
    await faceapi.nets.ageGenderNet.loadFromUri(modelUrl);
    log("Models Ready. Starting Camera...");
    startCamera();
}

async function startCamera() {
    try {
        const stream = await navigator.mediaDevices.getUserMedia({ video: { width: 320, height: 240 } });
        video.srcObject = stream;
        video.onloadeddata = () => {
            canvasElement.width = video.videoWidth;
            canvasElement.height = video.videoHeight;
            log("System Online. Skeleton Tracking Active.");
            loop();
        };
    } catch (err) { log("Error: " + err.message); }
}

async function loop() {
    if (video.readyState >= 2) {
        await hands.send({ image: video });
        await faceMesh.send({ image: video });
        frameCounter++;
        if (frameCounter % 5 === 0) detectFaceAttributes();
    }
    requestAnimationFrame(loop);
}

async function detectFaceAttributes() {
    const displaySize = { width: 320, height: 240 };
    const options = new faceapi.TinyFaceDetectorOptions({ inputSize: 224, scoreThreshold: 0.3 });
    const detections = await faceapi.detectAllFaces(video, options).withAgeAndGender();
    hudContainer.innerHTML = '';

    if (detections && detections.length > 0) {
        const resizedDetections = faceapi.resizeResults(detections, displaySize);
        resizedDetections.forEach(detection => {
            const { age, gender, genderProbability } = detection;
            const box = detection.detection.box;
            const mirroredX = displaySize.width - (box.x + box.width);
            
            const label = document.createElement('div');
            label.className = 'face-label';
            label.style.left = `${Math.max(0, mirroredX)}px`;
            label.style.top = `${Math.max(0, box.y - 35)}px`;
            
            const ageInt = Math.round(age);
            const genderStr = genderProbability > 0.6 ? gender.toUpperCase() : "SCAN";
            label.innerHTML = `${genderStr} [${ageInt}]`;
            const color = gender === 'male' ? '#00aaff' : '#ff00aa';
            label.style.borderColor = color;
            label.style.color = color;
            label.style.boxShadow = `0 0 5px ${color}`;

            hudContainer.appendChild(label);
        });
    }
}

const clock = new THREE.Clock();
function animate() {
    const time = clock.getElapsedTime();
    material.uniforms.uTime.value = time;
    fadePlane.lookAt(camera.position);

    const dist = indexFingerTip.distanceTo(orb.position);
    if (dist < 4.0) {
        orb.rotation.x += 0.2; orb.rotation.y += 0.2;
        orb.scale.setScalar(1.5 + Math.sin(time * 10.0)*0.2);
        orb.material.color.setHex(0xff0000);
    } else {
        orb.rotation.x += 0.01; orb.rotation.y += 0.01;
        orb.scale.setScalar(1.0);
        orb.material.color.setHex(0xaa00ff);
    }

    const posArr = geometry.attributes.position.array;
    const visArr = geometry.attributes.aVisible.array;
    const velArr = velocities;

    for (let i = 0; i < TOTAL_PARTICLES; i++) {
        if (isDisintegrating && visArr[i] > 0.01) {
            posArr[i*3] += velArr[i*3] + Math.sin(time + i)*0.05; 
            posArr[i*3+1] += velArr[i*3+1] + 0.1; 
            posArr[i*3+2] += velArr[i*3+2];
            visArr[i] *= 0.96; 
        } else {
            posArr[i*3] += (targetPositions[i*3] - posArr[i*3]) * 0.15;
            posArr[i*3+1] += (targetPositions[i*3+1] - posArr[i*3+1]) * 0.15;
            posArr[i*3+2] += (targetPositions[i*3+2] - posArr[i*3+2]) * 0.15;
            visArr[i] += (targetVisibility[i] - visArr[i]) * 0.1;
        }
    }
    
    geometry.attributes.position.needsUpdate = true;
    geometry.attributes.aVisible.needsUpdate = true;

    controls.update();
    renderer.render(scene, camera);
    requestAnimationFrame(animate);
}

window.addEventListener('keydown', (e) => {
    if (e.code === 'Space') {
        isDisintegrating = !isDisintegrating;
        log(isDisintegrating ? "Disintegrating..." : "Reforming...");
    }
});
window.addEventListener('resize', () => {
    camera.aspect = window.innerWidth / window.innerHeight;
    camera.updateProjectionMatrix();
    renderer.setSize(window.innerWidth, window.innerHeight);
});

const pane = new Pane({ title: 'System' });
pane.addBinding(material.uniforms.uColor, 'value', { label: 'Core Color' });

init();
animate();