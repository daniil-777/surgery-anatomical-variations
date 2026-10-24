import { describe, expect, it } from "vitest";
import * as THREE from "three";
import { createOperativeEnvelope, operativeEntry } from "./operativeView";
import { SceneNavigationGuard } from "./wholeSceneNavigation";

describe("operative entry and enclosure", () => {
  it("stops outside an intervening organ instead of placing the scope in the requested target", () => {
    const stomach = new THREE.SphereGeometry(40, 24, 16);
    const overlying = new THREE.SphereGeometry(55, 24, 16).translate(25, -10, 65);
    const surfaces = [{id:"stomach",visible:true,geometry:stomach},{id:"liver",visible:true,geometry:overlying}];
    const guard = new SceneNavigationGuard(()=>surfaces), entry = operativeEntry(surfaces,"gastric",guard)!;
    expect(entry).not.toBeNull();
    expect(guard.rayDistance(entry.position,entry.forward,100)).toBeCloseTo(entry.workingDistance,3);
    expect(guard.closest(entry.position,20)).toBeNull();
    const swept=guard.move(entry.position,entry.position.clone().addScaledVector(entry.forward,300),new THREE.Box3(new THREE.Vector3(-1000,-1000,-1000),new THREE.Vector3(1000,1000,1000)));
    expect(swept.blocked).toBe(true); expect(swept.blockedBy).toBe("liver");
    stomach.dispose();overlying.dispose();
  });
  it("does not invent regional entries for unnamed uploads", () => {
    expect(operativeEntry([],"subhepatic",new SceneNavigationGuard(()=>[]))).toBeNull();
    expect(createOperativeEnvelope([])).toBeNull();
  });
  it("encloses the abdominal center and blocks travel through its inner wall", () => {
    const source=new THREE.BoxGeometry(220,300,120);
    const envelope=createOperativeEnvelope([{id:"liver",visible:true,geometry:source}])!;
    const geometry=envelope.mesh.geometry;
    expect(envelope.mesh.material.side).toBe(THREE.BackSide);
    const guard=new SceneNavigationGuard(()=>[{id:envelope.mesh.name,visible:true,geometry}]);
    const center=geometry.boundingBox!.getCenter(new THREE.Vector3());
    const result=guard.move(center,center.clone().add(new THREE.Vector3(500,0,0)),geometry.boundingBox!.clone().expandByScalar(100));
    expect(result.blockedBy).toBe("operative-peritoneal-wall");
    expect(result.position.x).toBeLessThan(geometry.boundingBox!.max.x);
    expect(Array.from(geometry.getAttribute("position").array).every(Number.isFinite)).toBe(true);
    envelope.dispose();source.dispose();
  });
});
