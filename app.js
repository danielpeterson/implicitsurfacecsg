// Import statements (assuming module system)
import * as THREE from './external/three.module.min.js';
import { OrbitControls } from './external/OrbitControls.js';

//-----------------------------------------------------------------------------
// Three.js
//-----------------------------------------------------------------------------

const scene = new THREE.Scene();

// Scene setup
scene.background = new THREE.Color(0xffffff);

// Camera setup
const camera = new THREE.PerspectiveCamera(45, window.innerWidth / window.innerHeight, 1, 1000);
camera.position.set(0, 0, 30);
camera.lookAt(scene.position);

// Renderer setup
const renderer = new THREE.WebGLRenderer({ antialias: true });
renderer.setSize(window.innerWidth, window.innerHeight);
document.body.appendChild(renderer.domElement);

// Add controls
const controls = new OrbitControls(camera, renderer.domElement);

// Lighting

const spotLight = new THREE.SpotLight(0xffffff);
spotLight.distance = 100;
spotLight.decay = 0;
scene.add(spotLight);

const ambientLight = new THREE.AmbientLight(0xffffff);
scene.add(ambientLight);

// Render loop
function animate() {
    requestAnimationFrame(animate);
    spotLight.position.copy(camera.position);
    controls.update();
    renderer.render(scene, camera);
}

animate();

// Handle window resize
window.addEventListener('resize', onWindowResize, false);
function onWindowResize() {
    camera.aspect = window.innerWidth / window.innerHeight;
    camera.updateProjectionMatrix();
    renderer.setSize(window.innerWidth, window.innerHeight);
}


//-----------------------------------------------------------------------------
// Visualization
//-----------------------------------------------------------------------------

function addPointsToScene(modelPoints, color, transparent = false) {
    if (modelPoints.length == 0) {
        return
    }

    const geometry = new THREE.BufferGeometry().setFromPoints(modelPoints);
    const material = new THREE.PointsMaterial({ color: color, size: 0.4, opacity: 0.1, transparent: transparent });
    const points = new THREE.Points(geometry, material);
    scene.add(points);
}


//-----------------------------------------------------------------------------
// Constants
//-----------------------------------------------------------------------------

// Max deviation from exact position that counts as valid
const EPSILON = 0.001;

// How many points will be generated for different types of features
const CSG_SURFACE_DENSITY = 10;
const LINE_DENSITY = 1;
const PRIMITIVE_SURFACE_DENSITY = 5;

// Defines a points position relative to a surface
const OUTSIDE_SURFACE = 0;
const ON_SURFACE = 1;
const INSIDE_SURFACE = 2;


//-----------------------------------------------------------------------------
// Surface types
//-----------------------------------------------------------------------------
class Surface {
    constructor(color, position = new THREE.Vector3(0, 0, 0), orientation = new THREE.Euler(0, 0, 0)) {
        this.color = color;
        this.position = position;
        this.quaternionRotation = new THREE.Quaternion().setFromEuler(orientation);
        this.matrix = new THREE.Matrix4().compose(position, this.quaternionRotation, new THREE.Vector3(1, 1, 1));
    }

    // Methods to be implemented by subclasses
    generatePoint() { }
    normalAt(point) { }
    closestPointTo(point) { }
    area() { }
}

class PlaneSurface extends Surface {
    constructor(width, height, color, position, orientation) {
        super(color, position, orientation);
        this.width = width;
        this.height = height;
    }

    generatePoint() { return new THREE.Vector3(Math.random() * this.width - this.width / 2, Math.random() * this.height - this.height / 2, 0); }
    normalAt() { return new THREE.Vector3(0, 0, 1); }
    closestPointTo(point) { return new THREE.Vector3(point.x, point.y, 0); }
    area() { return this.width * this.height; }
}

class CylinderSurface extends Surface {
    constructor(radius, height, color, position, orientation) {
        super(color, position, orientation);
        this.radius = radius;
        this.height = height;
    }

    generatePoint() {
        const angle = Math.random() * 2 * Math.PI;
        const x = this.radius * Math.cos(angle);
        const y = this.radius * Math.sin(angle);
        const z = Math.random() * this.height - this.height / 2;
        return new THREE.Vector3(x, y, z);
    }

    normalAt(point) { return new THREE.Vector3(point.x, point.y, 0).normalize(); }

    closestPointTo(point) {
        const dir = new THREE.Vector3(point.x, point.y, 0).normalize();
        const x = this.radius * dir.x;
        const y = this.radius * dir.y;
        const z = THREE.MathUtils.clamp(point.z, -this.height / 2, this.height / 2);
        return new THREE.Vector3(x, y, z);
    }

    area() { return 2 * Math.PI * this.radius * this.height; }
}

class SphereSurface extends Surface {
    constructor(radius, color, position, orientation) {
        super(color, position, orientation);
        this.radius = radius;
    }

    generatePoint() {
        let p = new THREE.Vector3();
        do {
            p.set(Math.random(), Math.random(), Math.random()).multiplyScalar(2).addScalar(-1);
        } while (p.length() > 1);
        return p.normalize().multiplyScalar(this.radius);
    }

    normalAt(point) { return point.clone().normalize(); }
    closestPointTo(point) { return point.clone().setLength(this.radius); }
    area() { return 4 * Math.PI * this.radius ** 2; }
}


//-----------------------------------------------------------------------------
// Surface point/edge generation
//-----------------------------------------------------------------------------

// This function generates a set of random points in world space that all lie on the given surface
function generateSurfacePoints(surface, density) {
    const count = Math.floor(surface.area() * density);
    const points = [];
    for (let i = 0; i < count; i++) {
        points.push(surface.generatePoint().applyMatrix4(surface.matrix));
    }

    return points
}

// This function generates random points on the edge(s) between a pair of surfaces
function generateSurfaceEdges(surface1, surface2) {
    const MAX_ITERATIONS = 100;
    const IMPROVEMENT_THRESHOLD = 0.01;
    const edgeEpsilon = EPSILON * 0.1;
    const edgePoints = [];

    const surface1InvMatrix = surface1.matrix.clone().invert();
    const surface2InvMatrix = surface2.matrix.clone().invert();

    const points = generateSurfacePoints(surface1, LINE_DENSITY);

    for (const point of points) {
        let currentPoint = point.clone();
        let prevDistance = Infinity;

        for (let iter = 0; iter < MAX_ITERATIONS; iter++) {
            const closestPoint1 = surface1.closestPointTo(currentPoint.clone().applyMatrix4(surface1InvMatrix)).applyMatrix4(surface1.matrix);
            const closestPoint2 = surface2.closestPointTo(currentPoint.clone().applyMatrix4(surface2InvMatrix)).applyMatrix4(surface2.matrix);
            currentPoint.lerp(closestPoint1, 0.5).lerp(closestPoint2, 0.5);

            const distance = closestPoint1.distanceTo(closestPoint2);

            if (distance < edgeEpsilon) {
                edgePoints.push(currentPoint);
                break;
            }

            if (((prevDistance - distance) / prevDistance) < IMPROVEMENT_THRESHOLD) {
                break;
            }

            prevDistance = distance;
        }
    }

    return edgePoints;
}


//-----------------------------------------------------------------------------
// CSG evaluation
//-----------------------------------------------------------------------------

function isPointInsideSurface(point, surface) {
    // Inverse transform the point to the local coordinates of the surface
    const inverseMatrix = surface.matrix.clone().invert();
    const localPoint = point.clone().applyMatrix4(inverseMatrix);

    // Compute the closest point on the surface in local coordinates
    const closestPoint = surface.closestPointTo(localPoint);
    const normal = surface.normalAt(closestPoint);
    const vectorToPoint = new THREE.Vector3().subVectors(closestPoint, localPoint);
    const dot = vectorToPoint.dot(normal);

    // Point is inside if dot product is positive
    if (dot > EPSILON) {
        return INSIDE_SURFACE;
    } else if (dot < -EPSILON) {
        return OUTSIDE_SURFACE;
    }

    return ON_SURFACE;
}

function isPointInsideShape(point, pointSurface, shape) {
    let result = INSIDE_SURFACE;

    for (const surface of shape) {
        if (surface === pointSurface) {
            return ON_SURFACE;
        }

        const a = isPointInsideSurface(point, surface)

        if (a == OUTSIDE_SURFACE) {
            return OUTSIDE_SURFACE;
        } else if (a == ON_SURFACE) {
            result = ON_SURFACE;
        }
    }

    return result;
}

function isLeafNode(node) { return !node.operation }

function isPointInsideNode(point, pointSurface, node) {
    if (isLeafNode(node)) {
        const shape = node;
        return isPointInsideShape(point, pointSurface, shape);
    }

    const a = isPointInsideNode(point, pointSurface, node.left);
    const b = isPointInsideNode(point, pointSurface, node.right);

    switch (node.operation) {
        case OperationType.UNION:
            if (a == OUTSIDE_SURFACE && b == OUTSIDE_SURFACE) {
                return OUTSIDE_SURFACE;
            }
            if (a == INSIDE_SURFACE || b == INSIDE_SURFACE) {
                return INSIDE_SURFACE;
            }
            return ON_SURFACE;
        case OperationType.SUBTRACT:
            if (a == INSIDE_SURFACE || a == ON_SURFACE) {
                if (b == OUTSIDE_SURFACE) {
                    return a;
                } else if (b == ON_SURFACE) {
                    return ON_SURFACE;
                }
            }
            return OUTSIDE_SURFACE;
        case OperationType.INTERSECT:
            if (a == OUTSIDE_SURFACE || b == OUTSIDE_SURFACE) {
                return OUTSIDE_SURFACE;
            }
            return (a == ON_SURFACE || b == ON_SURFACE) ? ON_SURFACE : INSIDE_SURFACE;
        default:
            return OUTSIDE_SURFACE;
    }
}


//-----------------------------------------------------------------------------
// Surfaces
//-----------------------------------------------------------------------------

// The model size is just a number that defines the dimensions of the CSG surfaces
const modelSize = 8;

// Cube defined by six planes
const cubeSize = modelSize * 2;
const cubePosition = new THREE.Vector3(0, 0, modelSize);

// Plane positions and orientation using THREE.Vector3 and THREE.Euler
const planes = [
    { position: new THREE.Vector3(0, 0, cubeSize / 2), orientation: new THREE.Euler(0, 0, 0) }, // Top
    { position: new THREE.Vector3(0, 0, -cubeSize / 2), orientation: new THREE.Euler(Math.PI, 0, 0) }, // Bottom
    { position: new THREE.Vector3(0, cubeSize / 2, 0), orientation: new THREE.Euler(-Math.PI / 2, 0, 0) }, // Front
    { position: new THREE.Vector3(0, -cubeSize / 2, 0), orientation: new THREE.Euler(Math.PI / 2, 0, 0) }, // Back
    { position: new THREE.Vector3(cubeSize / 2, 0, 0), orientation: new THREE.Euler(0, Math.PI / 2, 0) }, // Right
    { position: new THREE.Vector3(-cubeSize / 2, 0, 0), orientation: new THREE.Euler(0, -Math.PI / 2, 0) }, // Left
];

const cubeSurfaces = planes.map((p) => new PlaneSurface(cubeSize, cubeSize, 0xff0000, p.position.add(cubePosition), p.orientation));
const cylinderSurfaces = [new CylinderSurface(modelSize / 2, modelSize * 3, 0x00ff00, cubePosition.clone(), new THREE.Vector3(0, 0, -modelSize / 3))];
const sphereSurfaces = [new SphereSurface(modelSize, 0x0000ff)];


//-----------------------------------------------------------------------------
// CSG model definition
//-----------------------------------------------------------------------------

const allSurfaces = [...cylinderSurfaces, ...cubeSurfaces, ...sphereSurfaces];

// Define operation types
const OperationType = {
    UNION: 'union',
    SUBTRACT: 'subtract',
    INTERSECT: 'intersect',
};

const model = {
    operation: OperationType.SUBTRACT,
    left: sphereSurfaces,
    right: {
        operation: OperationType.SUBTRACT,
        left: cubeSurfaces,
        right: cylinderSurfaces,
    }
};

// Surfaces
allSurfaces.forEach((surface) => {
    const points = generateSurfacePoints(surface, CSG_SURFACE_DENSITY).filter((point) => isPointInsideNode(point, surface, model) == ON_SURFACE);
    addPointsToScene(points, surface.color);
});

// Edges
allSurfaces.forEach((surface) => {
    for (const other of allSurfaces) {
        if (surface == other) {
            continue;
        }

        const points = generateSurfaceEdges(surface, other).filter((point) => isPointInsideNode(point, surface, model) == ON_SURFACE);
        addPointsToScene(points, 0x000000);
    }
});

// Primitives
// allSurfaces.forEach((surface) => {
//     const points = generateSurfacePoints(surface, PRIMITIVE_SURFACE_DENSITY);
//     addPointsToScene(points, surface.color, true);
// });
