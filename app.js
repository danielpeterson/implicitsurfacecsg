// Import statements (assuming module system)
import * as THREE from './external/three.module.min.js';
import { OrbitControls } from './external/OrbitControls.js';


//-----------------------------------------------------------------------------
// Constants
//-----------------------------------------------------------------------------

// Define operation types
const OperationType = {
    UNION: 'union',
    SUBTRACT: 'subtract',
    INTERSECT: 'intersect',
};

// Point cloud
const POINT_CLOUD_DENSITY = 20; // Adjust this value to control the number of points
const POINT_CLOUD_SIZE_X = 20; // From -1 to +1 in X, Y and Z
const POINT_CLOUD_SIZE_Y = 20; // From -1 to +1 in X, Y and Z
const POINT_CLOUD_SIZE_Z = 40; // From -1 to +1 in X, Y and Z
const POINT_CLOUD_MAX_PROJECTION_DISTANCE = 0.3; // Maximum distance for point projection

// Max deviation from exact position that counts as valid
const EPSILON = 0.001;

// Defines a points position relative to a surface
const OUTSIDE_SURFACE = 0;
const ON_SURFACE = 1;
const INSIDE_SURFACE = 2;

// Edge finding loop control
const EDGE_SEARCH_MAX_ITERATIONS = 100;
const EDGE_SEARCH_EPSILON = EPSILON * 0.1;


//-----------------------------------------------------------------------------
// Surface types
//-----------------------------------------------------------------------------
class Surface {
    constructor(color, position = new THREE.Vector3(0, 0, 0), orientation = new THREE.Euler(0, 0, 0)) {
        this.color = color;
        this.position = position;
        this.quaternionRotation = new THREE.Quaternion().setFromEuler(orientation);
        this.matrix = new THREE.Matrix4().compose(position, this.quaternionRotation, new THREE.Vector3(1, 1, 1));
        this.invMatrix = this.matrix.clone().invert();
    }

    // Methods to be implemented by subclasses
    normalAt(point) { }
    projectPoint(point) { }
    toLocal(world) { return world.clone().applyMatrix4(this.invMatrix); }
    toWorld(local) { return local.clone().applyMatrix4(this.matrix); }
    rotateToWorld(normal) { return normal.clone().applyQuaternion(this.quaternionRotation); }
}

class PlaneSurface extends Surface {
    constructor(color, position, orientation) {
        super(color, position, orientation);
        this.normal = new THREE.Vector3(0, 0, 1);
    }

    normalAt() { return this.rotateToWorld(this.normal); }
    projectPoint(point) { return this.toWorld(this.toLocal(point).setZ(0)); }
}

class CylinderSurface extends Surface {
    constructor(radius, color, position, orientation) {
        super(color, position, orientation);
        this.radius = radius;
    }

    normalAt(point) { return this.rotateToWorld(this.toLocal(point).setZ(0).normalize()); }
    projectPoint(point) { return this.toWorld(this.toLocal(point).setZ(0).normalize().multiplyScalar(this.radius).setZ(this.toLocal(point).z)); }
}

class SphereSurface extends Surface {
    constructor(radius, color, position, orientation) {
        super(color, position, orientation);
        this.radius = radius;
    }

    normalAt(point) { return this.rotateToWorld(this.toLocal(point).normalize()); }
    projectPoint(point) { return this.toWorld(this.toLocal(point).setLength(this.radius)); }
}


//-----------------------------------------------------------------------------
// Surface point/edge generation
//-----------------------------------------------------------------------------

function generatePointCloud(density) {
    const pointCount = Math.floor(POINT_CLOUD_SIZE_X * POINT_CLOUD_SIZE_Y * POINT_CLOUD_SIZE_Z * density);

    return Array.from(new Array(pointCount), () => new THREE.Vector3(
        THREE.MathUtils.randFloat(-POINT_CLOUD_SIZE_X / 2, POINT_CLOUD_SIZE_X / 2),
        THREE.MathUtils.randFloat(-POINT_CLOUD_SIZE_Y / 2, POINT_CLOUD_SIZE_Y / 2),
        THREE.MathUtils.randFloat(-POINT_CLOUD_SIZE_Z / 2, POINT_CLOUD_SIZE_Z / 2)
    ));
}

function findEdgePoint(point, surface1, surface2) {
    const closestPoint = point.clone();
    for (let i = 0; i < EDGE_SEARCH_MAX_ITERATIONS; i++) {
        const p1 = surface1.projectPoint(closestPoint);
        const p2 = surface2.projectPoint(closestPoint);
        closestPoint.lerpVectors(p1, p2, 0.5);

        if (p1.distanceTo(p2) < EDGE_SEARCH_EPSILON) {
            return closestPoint;
        }
    }

    return null;
}

function projectPoints(points, surfaces) {
    const surfacePoints = surfaces.map(() => []);
    const edgePoints = surfaces.map(() => []);

    points.forEach(point => {
        surfaces.forEach((surface, index) => {
            const projectedPoint = surface.projectPoint(point);

            if (point.distanceTo(projectedPoint) <= POINT_CLOUD_MAX_PROJECTION_DISTANCE) {
                surfacePoints[index].push(projectedPoint);

                // Check for edge points
                surfaces.forEach((otherSurface, otherIndex) => {
                    if (index !== otherIndex) {
                        const otherProjectedPoint = otherSurface.projectPoint(point);

                        // We allow slightly more points on the opposing surface to get more solid edge lines
                        if (point.distanceTo(otherProjectedPoint) <= POINT_CLOUD_MAX_PROJECTION_DISTANCE * 5) {
                            const edgePoint = findEdgePoint(point, surface, otherSurface);

                            if (edgePoint) {
                                edgePoints[index].push(edgePoint);
                            }
                        }
                    }
                });
            }
        });
    });

    return { surfacePoints, edgePoints };
}


//-----------------------------------------------------------------------------
// CSG evaluation
//-----------------------------------------------------------------------------

function isPointInsideSurface(point, surface) {
    const closestPoint = surface.projectPoint(point);
    const dot = closestPoint.clone().sub(point).dot(surface.normalAt(closestPoint));

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

const cubeSurfaces = planes.map((p) => new PlaneSurface(0xff0000, p.position.add(cubePosition), p.orientation));
const cylinderSurfaces = [new CylinderSurface(modelSize / 2, 0x00ff00, cubePosition.clone())];
const sphereSurfaces = [new SphereSurface(modelSize, 0x0000ff)];


//-----------------------------------------------------------------------------
// CSG model definition
//-----------------------------------------------------------------------------

const allSurfaces = [...cylinderSurfaces, ...cubeSurfaces, ...sphereSurfaces];

const pointCloud = generatePointCloud(POINT_CLOUD_DENSITY);
const { surfacePoints, edgePoints } = projectPoints(pointCloud, allSurfaces);

const model = {
    operation: OperationType.SUBTRACT,
    left: sphereSurfaces,
    right: {
        operation: OperationType.SUBTRACT,
        left: cubeSurfaces,
        right: cylinderSurfaces,
    }
};

function createThreeJSPoints(modelPoints, color) {
    const geometry = new THREE.BufferGeometry().setFromPoints(modelPoints);
    const material = new THREE.PointsMaterial({ color: color, size: 0.4 });
    const points = new THREE.Points(geometry, material);
    return points;
}

// CSG surfaces
const csgSurfacePoints = surfacePoints.map((points, index) => {
    return createThreeJSPoints(points.filter(point => isPointInsideNode(point, allSurfaces[index], model) === ON_SURFACE), allSurfaces[index].color);
});

// CSG edges
const csgEdgePoints = edgePoints.map((points, index) => {
    return createThreeJSPoints(points.filter(point => isPointInsideNode(point, allSurfaces[index], model) === ON_SURFACE), 0x000000);
});


// Original surfaces
const originalSurfacePoints = surfacePoints.map((surfacePoints, index) => {
    return createThreeJSPoints(surfacePoints, allSurfaces[index].color);
});


//-----------------------------------------------------------------------------
// UI
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

// Render loop
function animate() {
    requestAnimationFrame(animate);
    controls.update();
    renderer.render(scene, camera);
}

// UI checkbox
function toggleMode() {
    const checked = toggleModeEl.checked;

    csgSurfacePoints.forEach((m) => scene.remove(m));
    csgEdgePoints.forEach((m) => scene.remove(m));
    originalSurfacePoints.forEach((m) => scene.remove(m));

    if (checked) {
        originalSurfacePoints.forEach((m) => scene.add(m));
    } else {
        csgSurfacePoints.forEach((m) => scene.add(m));
        csgEdgePoints.forEach((m) => scene.add(m));
    }
}

const toggleModeEl = document.getElementById("toggleMode")
toggleModeEl.addEventListener("change", toggleMode);
toggleMode(false);

// Handle window resize
window.addEventListener('resize', onWindowResize, false);
function onWindowResize() {
    camera.aspect = window.innerWidth / window.innerHeight;
    camera.updateProjectionMatrix();
    renderer.setSize(window.innerWidth, window.innerHeight);
}

// Start animation
requestAnimationFrame(animate);
