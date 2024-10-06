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
const POINT_CLOUD_SIZE = 20; // From -1 to +1 in X, Y and Z
const POINT_CLOUD_MAX_PROJECTION_DISTANCE = 0.3; // Maximum distance for point projection

// Max deviation from exact position that counts as valid
const EPSILON = 0.001;

// Defines a points position relative to a surface
const OUTSIDE_SURFACE = 0;
const ON_SURFACE = 1;
const INSIDE_SURFACE = 2;

// Edge finding loop control
const EDGE_SEARCH_MAX_ITERATIONS = 100;


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

class ChamferSurface extends Surface {
    constructor(surface1, surface2, length, color, position = new THREE.Vector3(0, 0, 0), orientation = new THREE.Euler(0, 0, 0)) {
        super(color, position, orientation);
        this.surface1 = surface1;
        this.surface2 = surface2;
        this.length = length;
    }

    normalAt(point) { return this.surface1.normalAt(point).negate().add(this.surface2.normalAt(point)).normalize(); }

    projectPoint(point) {
        const edgePoint = findEdgePoint(point, this.surface1, this.surface2);
        
        if (!edgePoint) {
            return new THREE.Vector3(0, 0, 0); // TODO: We are cheating here...
        }

        const edgeNormal = this.normalAt(edgePoint);
        const planePoint = edgePoint.clone().add(edgeNormal.clone().multiplyScalar(this.length));

        const chamferPlane = new THREE.Plane(edgeNormal, -edgeNormal.dot(planePoint));

        const chamferPoint = new THREE.Vector3();
        chamferPlane.projectPoint(point, chamferPoint);

        // Project the point onto the fillet surface
        return chamferPoint;
    }
}


//-----------------------------------------------------------------------------
// Surface point/edge generation
//-----------------------------------------------------------------------------

// Fill a cubic region around the origin with random points
function generatePointCloud(density) {
    const pointCount = Math.floor(POINT_CLOUD_SIZE * POINT_CLOUD_SIZE * POINT_CLOUD_SIZE * density);

    return Array.from(new Array(pointCount), () => new THREE.Vector3(
        THREE.MathUtils.randFloat(-POINT_CLOUD_SIZE / 2, POINT_CLOUD_SIZE / 2),
        THREE.MathUtils.randFloat(-POINT_CLOUD_SIZE / 2, POINT_CLOUD_SIZE / 2),
        THREE.MathUtils.randFloat(-POINT_CLOUD_SIZE / 2, POINT_CLOUD_SIZE / 2)
    ));
}

// Find the correspoinding edge point to any point and surface pair by 
// iteratively refining the point position towards the edge
function findEdgePoint(point, surface1, surface2) {
    for (let i = 0; i < EDGE_SEARCH_MAX_ITERATIONS; i++) {
        const p2 = surface1.projectPoint(point);
        const p1 = surface2.projectPoint(p2);

        if (p1.distanceTo(p2) < EPSILON) {
            return p1;
        }

        point = p1;
    }

    return null;
}

// Find surfaces by projecting points in a point cloud onto each surface in turn.
// For any points that are sufficiently close to the surface to begin with we
// project them onto the surface using the surface.projectPoint function to get 
// a point that lies exactly on the surface.
// For each point that lies in proximity to two surfaces we find an exact intersection point
// and add that point to the edge points.
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

                        if (point.distanceTo(otherProjectedPoint) <= POINT_CLOUD_MAX_PROJECTION_DISTANCE) {
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

// Use the closest point on a surface and corresponding surface normal to determine 
// how a point is located in relation to the surface.
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

// Loop over all the surfaces in a shape and determine if a point is indisde, outside
// or on the surface of that shape.
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

// Tells if a node is a leaf node in the CSG tree.
// Leaf nodes hold actual shapes (lists of surfaces)
function isLeafNode(node) { return !node.operation }

// Check if a point is part of a node in the CSG tree

// TODO: There is a bug here. Some ghost edge points show up on the surface of the final model
// even though they should have been culled by the CSG evaluation.
// This happens for points on one surface that should be culled, but that happens to lie exacly on
// another surface that is part of the mode.
// It would probably be necessary to take into account from what surface the points are spawned
// by when evaluating the CSG tree to avoid that they show up higher up in the tree because they
// happen to lie exactly on some other surface that is included. This is most visible for edges
// Where all edge intersections spawn surface points. This means that all raw edges that lie on
// the surface of the final model will be visible even though one of the surfaces they belong
// to have been culled.
function isPointInsideNode(point, pointSurface, node) {
    if (isLeafNode(node)) {
        const shape = node;
        return isPointInsideShape(point, pointSurface, shape);
    }

    const a = isPointInsideNode(point, pointSurface, node.left);
    const b = isPointInsideNode(point, pointSurface, node.right);

    // This is the heart of the algorithm and it combines the CSG operations and lets us
    // know if a point in space is part in the model or not.
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
// Surface definitions
//-----------------------------------------------------------------------------

// The model size is just a number that defines the dimensions of the CSG surfaces
const modelSize = 8;

// Box defined by six planes
const boxSize = modelSize * 2;
const boxPosition = new THREE.Vector3(0, 0, modelSize);

const planes = [
    { position: new THREE.Vector3(0, 0, boxSize / 18), orientation: new THREE.Euler(0, 0, 0) }, // Top
    { position: new THREE.Vector3(0, 0, -boxSize / 2), orientation: new THREE.Euler(Math.PI, 0, 0) }, // Bottom
    { position: new THREE.Vector3(0, boxSize / 2, 0), orientation: new THREE.Euler(-Math.PI / 2, 0, 0) }, // Front
    { position: new THREE.Vector3(0, -boxSize / 2, 0), orientation: new THREE.Euler(Math.PI / 2, 0, 0) }, // Back
    { position: new THREE.Vector3(boxSize / 2, 0, 0), orientation: new THREE.Euler(0, Math.PI / 2, 0) }, // Right
    { position: new THREE.Vector3(-boxSize / 2, 0, 0), orientation: new THREE.Euler(0, -Math.PI / 2, 0) }, // Left
];

const boxSurfaces = planes.map((p) => new PlaneSurface(0xff0000, p.position.add(boxPosition), p.orientation));

const cylinderSurfaces = [new CylinderSurface(modelSize / 2, 0x00ff00, boxPosition.clone())];
const sphereSurfaces = [new SphereSurface(modelSize, 0x0000ff)];
const chamferSurfaces = [new ChamferSurface(boxSurfaces[1], cylinderSurfaces[0], modelSize / 8, 0xffff00, boxPosition.clone())];


//-----------------------------------------------------------------------------
// CSG model definition
//-----------------------------------------------------------------------------

const allSurfaces = [...cylinderSurfaces, ...boxSurfaces, ...sphereSurfaces, ...chamferSurfaces];

// The point cloud volume that cointains the model.
const pointCloud = generatePointCloud(POINT_CLOUD_DENSITY);

// For each surface/edge keep the points that are close to the surface/edge
const { surfacePoints, edgePoints } = projectPoints(pointCloud, allSurfaces);

// This is the CSG tree that defines how the surface are combined to create our final model
const model = {
    operation: OperationType.SUBTRACT,
    left: sphereSurfaces,
    right: {
        operation: OperationType.SUBTRACT,
        left: boxSurfaces,
        right: {
            operation: OperationType.UNION,
            left: cylinderSurfaces,
            right: chamferSurfaces,
        }
    }
};

// CSG surfaces
// Evaluate surfaces and keep the points that are part of the final model
const csgSurfacePoints = surfacePoints.map((points, index) => {
    return createThreeJSPoints(points.filter(point => isPointInsideNode(point, allSurfaces[index], model) === ON_SURFACE), allSurfaces[index].color);
});

// CSG edges
// Evaluate surfaces and keep the points that are part of the final model
const csgEdgePoints = edgePoints.map((points, index) => {
    return createThreeJSPoints(points.filter(point => isPointInsideNode(point, allSurfaces[index], model) === ON_SURFACE), 0x000000);
});

// Orignal surfaces
// Create Three.js Points objects for the original un-evaluated surfaces 
const originalSurfacePoints = surfacePoints.map((surfacePoints, index) => {
    return createThreeJSPoints(surfacePoints, allSurfaces[index].color);
});

// Point cloud
const cloudPoints = createThreeJSPoints(pointCloud, 0xffffff);


//-----------------------------------------------------------------------------
// UI
//-----------------------------------------------------------------------------

const scene = new THREE.Scene();

// Scene setup
scene.background = new THREE.Color(0xd0d0d0);

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

// Creates a Three.js Points object from an array of vectors.
function createThreeJSPoints(modelPoints, color) {
    const geometry = new THREE.BufferGeometry().setFromPoints(modelPoints);
    const material = new THREE.PointsMaterial({ color: color, size: 0.4 });
    const points = new THREE.Points(geometry, material);
    return points;
}

// UI checkbox
function hideAllPoints() {
    csgSurfacePoints.forEach((m) => scene.remove(m));
    csgEdgePoints.forEach((m) => scene.remove(m));
    originalSurfacePoints.forEach((m) => scene.remove(m));
    scene.remove(cloudPoints);
}

function showPointCloud() { 
    hideAllPoints();
    scene.add(cloudPoints); 
}
function showSurfaces() { 
    hideAllPoints();
    originalSurfacePoints.forEach((m) => scene.add(m)); 
}
function showModel() { 
    hideAllPoints();
    csgSurfacePoints.forEach((m) => scene.add(m));
    csgEdgePoints.forEach((m) => scene.add(m));
}

const modelButtonEl = document.getElementById("modelButton");
const surfaceButtonEl = document.getElementById("surfaceButton");
const cloudButtonEl = document.getElementById("cloudButton");

modelButtonEl.addEventListener("change", () => showModel());
surfaceButtonEl.addEventListener("change", () => showSurfaces());
cloudButtonEl.addEventListener("change", () => showPointCloud());

const loadingEl = document.getElementById("loading");
loadingEl.style.display = 'none';

// Handle window resize
window.addEventListener('resize', onWindowResize, false);
function onWindowResize() {
    camera.aspect = window.innerWidth / window.innerHeight;
    camera.updateProjectionMatrix();
    renderer.setSize(window.innerWidth, window.innerHeight);
}

// Start animation
requestAnimationFrame(animate);
showModel();

