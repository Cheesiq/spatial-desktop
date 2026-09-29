import { type Camera, type Mesh, Plane, type Ray, Raycaster, type Vector2, Vector3 } from '@iwsdk/core';

const raycaster = new Raycaster();
const normal = new Vector3();
const origin = new Vector3();
const plane = new Plane();

/** The parts of a pmndrs pointer event needed to rebuild its ray. */
export interface RayEvent {
  pointerType: string;
  pointer: Vector2;
  camera: Camera;
  ray: Ray;
}

/**
 * The ray the pointer is aiming along. XR controllers carry a real ray, but
 * for the mouse (pointerType "screen-mouse") `event.ray` is just the camera's
 * forward axis, so rebuild it through the cursor from `event.pointer` (NDC).
 */
export function pointerRay(event: RayEvent): Ray {
  if (!event.pointerType.startsWith('screen')) return event.ray;
  raycaster.setFromCamera(event.pointer, event.camera);
  return raycaster.ray;
}

/**
 * Where a ray meets a unit PlaneGeometry mesh (scaled however), as [u, v]
 * from the top-left, clamped to the mesh, plus whether it landed inside.
 */
export function meshUv(mesh: Mesh, ray: Ray, out: Vector3): { u: number; v: number; inside: boolean } | null {
  mesh.updateWorldMatrix(true, false);
  normal.set(0, 0, 1).transformDirection(mesh.matrixWorld);
  origin.setFromMatrixPosition(mesh.matrixWorld);
  if (!ray.intersectPlane(plane.setFromNormalAndCoplanarPoint(normal, origin), out)) return null;
  mesh.worldToLocal(out); // unit plane: local x/y in [-0.5, 0.5]
  const u = out.x + 0.5;
  const v = 0.5 - out.y;
  const inside = u >= 0 && u <= 1 && v >= 0 && v <= 1;
  return { u: Math.min(1, Math.max(0, u)), v: Math.min(1, Math.max(0, v)), inside };
}
