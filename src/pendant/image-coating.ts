import type { MeshPhysicalMaterial } from 'three'
import { MOTION_GLARE_FRAGMENT, type MotionGlareUniforms } from './motion-glare.js'

/** Two logical layers in one draw: unlit source image + native physical gloss.
 * Only reflection passes through exposure/tone mapping. No image recolouring,
 * extra light sources, textures or render targets.
 */
export function separateImageCoating(material: MeshPhysicalMaterial, glare?: MotionGlareUniforms): void {
  material.onBeforeCompile = shader => {
    const opaque = '#include <opaque_fragment>'
    const output = '#include <colorspace_fragment>'
    if (!shader.fragmentShader.includes(opaque) || !shader.fragmentShader.includes(output)) {
      throw new Error('Unsupported Three.js badge shader: image/coating output hooks missing')
    }
    if (glare) {
      shader.uniforms.badgeGlareProgress = glare.badgeGlareProgress
      shader.uniforms.badgeGlareOpacity = glare.badgeGlareOpacity
      shader.fragmentShader = 'uniform float badgeGlareProgress;\nuniform float badgeGlareOpacity;\n' + shader.fragmentShader
    }
    shader.fragmentShader = shader.fragmentShader.replace(opaque, `
      // Reuse Three's BRDF and actual scene reflection, without diffuse lighting.
      vec3 badgeReflection = totalSpecular;
      #ifdef USE_CLEARCOAT
        badgeReflection = badgeReflection * (1.0 - material.clearcoat * Fcc)
          + (clearcoatSpecularDirect + clearcoatSpecularIndirect) * material.clearcoat;
      #endif
      outgoingLight = ${glare ? 'vec3(0.0)' : 'max(badgeReflection, vec3(0.0))'};
      ${opaque}
    `).replace(output, `
      ${output}
      // diffuseColor already contains the decoded linear-sRGB image sample.
      // Convert it once, independently of the tone-mapped reflection above.
      vec3 badgeImage = linearToOutputTexel(diffuseColor).rgb;
      vec3 badgeCoating = 0.4 * clamp(gl_FragColor.rgb, 0.0, 1.0);
      gl_FragColor.rgb = badgeImage + (vec3(1.0) - badgeImage) * badgeCoating;
      ${glare ? MOTION_GLARE_FRAGMENT : ''}
    `)
  }
  material.customProgramCacheKey = () => glare ? 'partner-motion-glare-v1' : 'partner-image-coating-v1'
}
