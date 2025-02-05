import { Matrix4, Matrix3, Color, Vector2 } from 'three';
import { MaterialBase } from './MaterialBase.js';
import {
	MeshBVHUniformStruct, FloatVertexAttributeTexture, UIntVertexAttributeTexture,
	shaderStructs, shaderIntersectFunction,
} from 'three-mesh-bvh';
import { shaderMaterialStructs } from '../shader/shaderStructs.js';
import { MaterialsTexture } from '../uniforms/MaterialsTexture.js';
import { RenderTarget2DArray } from '../uniforms/RenderTarget2DArray.js';
import { shaderMaterialSampling } from '../shader/shaderMaterialSampling.js';
import { shaderEnvMapSampling } from '../shader/shaderEnvMapSampling.js';
import { shaderUtils } from '../shader/shaderUtils.js';
import { PhysicalCameraUniform } from '../uniforms/PhysicalCameraUniform.js';
import { EquirectHdrInfoUniform } from '../uniforms/EquirectHdrInfoUniform.js';

export class PhysicalPathTracingMaterial extends MaterialBase {

	onBeforeRender() {

		this.setDefine( 'FEATURE_DOF', this.physicalCamera.bokehSize === 0 ? 0 : 1 );

	}

	constructor( parameters ) {

		super( {

			transparent: true,
			depthWrite: false,

			defines: {
				FEATURE_MIS: 1,
				FEATURE_DOF: 1,
				FEATURE_GRADIENT_BG: 0,
				TRANSPARENT_TRAVERSALS: 5,
			},

			uniforms: {
				resolution: { value: new Vector2() },

				bounces: { value: 3 },
				physicalCamera: { value: new PhysicalCameraUniform() },

				bvh: { value: new MeshBVHUniformStruct() },
				normalAttribute: { value: new FloatVertexAttributeTexture() },
				tangentAttribute: { value: new FloatVertexAttributeTexture() },
				uvAttribute: { value: new FloatVertexAttributeTexture() },
				materialIndexAttribute: { value: new UIntVertexAttributeTexture() },
				materials: { value: new MaterialsTexture() },
				textures: { value: new RenderTarget2DArray().texture },
				cameraWorldMatrix: { value: new Matrix4() },
				invProjectionMatrix: { value: new Matrix4() },
				backgroundBlur: { value: 0.0 },
				environmentIntensity: { value: 2.0 },
				environmentRotation: { value: new Matrix3() },
				envMapInfo: { value: new EquirectHdrInfoUniform() },

				seed: { value: 0 },
				opacity: { value: 1 },
				filterGlossyFactor: { value: 0.0 },

				bgGradientTop: { value: new Color( 0x111111 ) },
				bgGradientBottom: { value: new Color( 0x000000 ) },
				backgroundAlpha: { value: 1.0 },
			},

			vertexShader: /* glsl */`

				varying vec2 vUv;
				void main() {

					vec4 mvPosition = vec4( position, 1.0 );
					mvPosition = modelViewMatrix * mvPosition;
					gl_Position = projectionMatrix * mvPosition;

					vUv = uv;

				}

			`,

			fragmentShader: /* glsl */`
				#define RAY_OFFSET 1e-4

				precision highp isampler2D;
				precision highp usampler2D;
				precision highp sampler2DArray;
				vec4 envMapTexelToLinear( vec4 a ) { return a; }
				#include <common>

				${ shaderStructs }
				${ shaderIntersectFunction }
				${ shaderMaterialStructs }

				${ shaderUtils }
				${ shaderMaterialSampling }
				${ shaderEnvMapSampling }

				uniform mat3 environmentRotation;
				uniform float backgroundBlur;
				uniform float backgroundAlpha;

				#if FEATURE_GRADIENT_BG

				uniform vec3 bgGradientTop;
				uniform vec3 bgGradientBottom;

				#endif

				#if FEATURE_DOF

				uniform PhysicalCamera physicalCamera;

				#endif

				uniform vec2 resolution;
				uniform int bounces;
				uniform mat4 cameraWorldMatrix;
				uniform mat4 invProjectionMatrix;
				uniform sampler2D normalAttribute;
				uniform sampler2D tangentAttribute;
				uniform sampler2D uvAttribute;
				uniform usampler2D materialIndexAttribute;
				uniform BVH bvh;
				uniform float environmentIntensity;
				uniform float filterGlossyFactor;
				uniform int seed;
				uniform float opacity;
				uniform sampler2D materials;

				uniform EquirectHdrInfo envMapInfo;

				uniform sampler2DArray textures;
				varying vec2 vUv;

				vec3 sampleBackground( vec3 direction ) {

					#if FEATURE_GRADIENT_BG

					direction = normalize( direction + randDirection() * 0.05 );

					float value = ( direction.y + 1.0 ) / 2.0;
					value = pow( value, 2.0 );

					return mix( bgGradientBottom, bgGradientTop, value );

					#else

					vec3 sampleDir = normalize( direction + getHemisphereSample( direction, rand2() ) * 0.5 * backgroundBlur );
					return environmentIntensity * sampleEquirectEnvMapColor( sampleDir, envMapInfo.map );

					#endif

				}

				// step through multiple surface hits and accumulate color attenuation based on transmissive surfaces
				bool attenuateHit( BVH bvh, vec3 rayOrigin, vec3 rayDirection, int traversals, bool isShadowRay, out vec3 color ) {

					// hit results
					uvec4 faceIndices = uvec4( 0u );
					vec3 faceNormal = vec3( 0.0, 0.0, 1.0 );
					vec3 barycoord = vec3( 0.0 );
					float side = 1.0;
					float dist = 0.0;

					color = vec3( 1.0 );

					for ( int i = 0; i < traversals; i ++ ) {

						if ( bvhIntersectFirstHit( bvh, rayOrigin, rayDirection, faceIndices, faceNormal, barycoord, side, dist ) ) {

							// TODO: attenuate the contribution based on the PDF of the resulting ray including refraction values
							// Should be able to work using the material BSDF functions which will take into account specularity, etc.
							// TODO: should we account for emissive surfaces here?

							vec2 uv = textureSampleBarycoord( uvAttribute, barycoord, faceIndices.xyz ).xy;
							uint materialIndex = uTexelFetch1D( materialIndexAttribute, faceIndices.x ).r;
							Material material = readMaterialInfo( materials, materialIndex );

							// adjust the ray to the new surface
							bool isBelowSurface = dot( rayDirection, faceNormal ) < 0.0;
							vec3 point = rayOrigin + rayDirection * dist;
							vec3 absPoint = abs( point );
							float maxPoint = max( absPoint.x, max( absPoint.y, absPoint.z ) );
							rayOrigin = point + faceNormal * ( maxPoint + 1.0 ) * ( isBelowSurface ? - RAY_OFFSET : RAY_OFFSET );

							if ( ! material.castShadow && isShadowRay ) {

								continue;

							}

							// Opacity Test

							// albedo
							vec4 albedo = vec4( material.color, material.opacity );
							if ( material.map != - 1 ) {

								albedo *= texture2D( textures, vec3( uv, material.map ) );

							}

							// transmission
							float transmission = material.transmission;
							if ( material.transmissionMap != - 1 ) {

								transmission *= texture2D( textures, vec3( uv, material.transmissionMap ) ).r;

							}

							// metalness
							float metalness = material.metalness;
							if ( material.metalnessMap != - 1 ) {

								metalness *= texture2D( textures, vec3( uv, material.metalnessMap ) ).b;

							}

							float alphaTest = material.alphaTest;
							bool useAlphaTest = alphaTest != 0.0;
							float transmissionFactor = ( 1.0 - metalness ) * transmission;
							if (
								transmissionFactor < rand() && ! (
									// material sidedness
									material.side != 0.0 && side == material.side

									// alpha test
									|| useAlphaTest && albedo.a < alphaTest

									// opacity
									|| ! useAlphaTest && albedo.a < rand()
								)
							) {

								return true;

							}

							// only attenuate on the way in
							if ( isBelowSurface ) {

								color *= albedo.rgb;

							}

						} else {

							return false;

						}

					}

					return true;

				}

				// returns whether the ray hit anything, not just the first surface. Could be optimized to not check the full hierarchy.
				bool anyHit( BVH bvh, vec3 rayOrigin, vec3 rayDirection ) {

					uvec4 faceIndices = uvec4( 0u );
					vec3 faceNormal = vec3( 0.0, 0.0, 1.0 );
					vec3 barycoord = vec3( 0.0 );
					float side = 1.0;
					float dist = 0.0;
					return bvhIntersectFirstHit( bvh, rayOrigin, rayDirection, faceIndices, faceNormal, barycoord, side, dist );

				}

				// tentFilter from Peter Shirley's 'Realistic Ray Tracing (2nd Edition)' book, pg. 60
				// erichlof/THREE.js-PathTracing-Renderer/
				float tentFilter( float x ) {

					return x < 0.5 ? sqrt( 2.0 * x ) - 1.0 : 1.0 - sqrt( 2.0 - ( 2.0 * x ) );

				}

				void main() {

					rng_initialize( gl_FragCoord.xy, seed );

					// get [-1, 1] normalized device coordinates
					vec2 ndc = 2.0 * vUv - vec2( 1.0 );
					vec3 rayOrigin, rayDirection;
					ndcToCameraRay( ndc, cameraWorldMatrix, invProjectionMatrix, rayOrigin, rayDirection );

					// Jitter the camera ray by finding a new subpixel point to point to from the camera origin
					// This is better than just jittering the camera position since it actually results in divergent
					// rays providing better coverage for the pixel
					{

						// TODO: the complexity here could be improved
						vec3 cameraOrigin = ( cameraWorldMatrix * vec4( 0.0, 0.0, 0.0, 1.0 ) ).xyz;
						vec3 ss00, ss01, ss10, temp;
						ndcToCameraRay( vec2( - 1.0, - 1.0 ), cameraWorldMatrix, invProjectionMatrix, ss00, temp );
						ndcToCameraRay( vec2( - 1.0, 1.0 ), cameraWorldMatrix, invProjectionMatrix, ss01, temp );
						ndcToCameraRay( vec2( 1.0, - 1.0 ), cameraWorldMatrix, invProjectionMatrix, ss10, temp );

						vec3 ssdX = ( ss10 - ss00 ) / resolution.x;
						vec3 ssdY = ( ss01 - ss00 ) / resolution.y;
						rayOrigin += tentFilter( rand() ) * ssdX + tentFilter( rand() ) * ssdY;
						rayDirection = normalize( rayOrigin - cameraOrigin );

					}

					#if FEATURE_DOF
					{

						// depth of field
						vec3 focalPoint = rayOrigin + normalize( rayDirection ) * physicalCamera.focusDistance;

						// get the aperture sample
						vec2 apertureSample = sampleAperture( physicalCamera.apertureBlades ) * physicalCamera.bokehSize * 0.5 * 1e-3;

						// rotate the aperture shape
						float ac = cos( physicalCamera.apertureRotation );
						float as = sin( physicalCamera.apertureRotation );
						apertureSample = vec2(
							apertureSample.x * ac - apertureSample.y * as,
							apertureSample.x * as + apertureSample.y * ac
						);
						apertureSample.x *= saturate( physicalCamera.anamorphicRatio );
						apertureSample.y *= saturate( 1.0 / physicalCamera.anamorphicRatio );

						// create the new ray
						rayOrigin += ( cameraWorldMatrix * vec4( apertureSample, 0.0, 0.0 ) ).xyz;
						rayDirection = focalPoint - rayOrigin;

					}
					#endif
					rayDirection = normalize( rayDirection );

					// inverse environment rotation
					mat3 invEnvironmentRotation = inverse( environmentRotation );

					// final color
					gl_FragColor = vec4( 0.0 );
					gl_FragColor.a = 1.0;

					// hit results
					uvec4 faceIndices = uvec4( 0u );
					vec3 faceNormal = vec3( 0.0, 0.0, 1.0 );
					vec3 barycoord = vec3( 0.0 );
					float side = 1.0;
					float dist = 0.0;

					// path tracing state
					float accumulatedRoughness = 0.0;
					bool transmissiveRay = true;
					int transparentTraversals = TRANSPARENT_TRAVERSALS;
					vec3 throughputColor = vec3( 1.0 );
					SampleRec sampleRec;
					int i;
					bool isShadowRay = false;

					for ( i = 0; i < bounces; i ++ ) {

						if ( ! bvhIntersectFirstHit( bvh, rayOrigin, rayDirection, faceIndices, faceNormal, barycoord, side, dist ) ) {

							if ( i == 0 || transmissiveRay ) {

								gl_FragColor.rgb += sampleBackground( environmentRotation * rayDirection ) * throughputColor;
								gl_FragColor.a = backgroundAlpha;

							} else {

								#if FEATURE_MIS

								// get the PDF of the hit envmap point
								vec3 envColor;
								float envPdf = envMapSample( environmentRotation * rayDirection, envMapInfo, envColor );

								// and weight the contribution
								float misWeight = misHeuristic( sampleRec.pdf, envPdf );
								gl_FragColor.rgb += environmentIntensity * envColor * throughputColor * misWeight;

								#else

								gl_FragColor.rgb +=
									environmentIntensity *
									sampleEquirectEnvMapColor( environmentRotation * rayDirection, envMapInfo.map ) *
									throughputColor;

								#endif

							}
							break;

						}

						uint materialIndex = uTexelFetch1D( materialIndexAttribute, faceIndices.x ).r;
						Material material = readMaterialInfo( materials, materialIndex );

						if ( material.matte && i == 0 ) {

							gl_FragColor = vec4( 0.0 );
							break;

						}

						// if we've determined that this is a shadow ray and we've hit an item with no shadow casting
						// then skip it
						if ( ! material.castShadow && isShadowRay ) {

							vec3 point = rayOrigin + rayDirection * dist;
							vec3 absPoint = abs( point );
							float maxPoint = max( absPoint.x, max( absPoint.y, absPoint.z ) );
							rayOrigin = point - ( maxPoint + 1.0 ) * faceNormal * RAY_OFFSET;

							continue;

						}

						vec2 uv = textureSampleBarycoord( uvAttribute, barycoord, faceIndices.xyz ).xy;

						// albedo
						vec4 albedo = vec4( material.color, material.opacity );
						if ( material.map != - 1 ) {

							albedo *= texture2D( textures, vec3( uv, material.map ) );

						}

						// possibly skip this sample if it's transparent, alpha test is enabled, or we hit the wrong material side
						// and it's single sided.
						// - alpha test is disabled when it === 0
						// - the material sidedness test is complicated because we want light to pass through the back side but still
						// be able to see the front side. This boolean checks if the side we hit is the front side on the first ray
						// and we're rendering the other then we skip it. Do the opposite on subsequent bounces to get incoming light.
						float alphaTest = material.alphaTest;
						bool useAlphaTest = alphaTest != 0.0;
						bool isFirstHit = i == 0;
						if (
							// material sidedness
							material.side != 0.0 && ( side != material.side ) == isFirstHit

							// alpha test
							|| useAlphaTest && albedo.a < alphaTest

							// opacity
							|| ! useAlphaTest && albedo.a < rand()
						) {

							vec3 point = rayOrigin + rayDirection * dist;
							vec3 absPoint = abs( point );
							float maxPoint = max( absPoint.x, max( absPoint.y, absPoint.z ) );
							rayOrigin = point - ( maxPoint + 1.0 ) * faceNormal * RAY_OFFSET;

							// only allow a limited number of transparency discards otherwise we could
							// crash the context with too long a loop.
							i -= sign( transparentTraversals );
							transparentTraversals -= sign( transparentTraversals );
							continue;

						}

						// fetch the interpolated smooth normal
						vec3 normal = normalize( textureSampleBarycoord(
							normalAttribute,
							barycoord,
							faceIndices.xyz
						).xyz );

						// roughness
						float roughness = material.roughness;
						if ( material.roughnessMap != - 1 ) {

							roughness *= texture2D( textures, vec3( uv, material.roughnessMap ) ).g;

						}

						// metalness
						float metalness = material.metalness;
						if ( material.metalnessMap != - 1 ) {

							metalness *= texture2D( textures, vec3( uv, material.metalnessMap ) ).b;

						}

						// emission
						vec3 emission = material.emissiveIntensity * material.emissive;
						if ( material.emissiveMap != - 1 ) {

							emission *= texture2D( textures, vec3( uv, material.emissiveMap ) ).xyz;

						}

						// transmission
						float transmission = material.transmission;
						if ( material.transmissionMap != - 1 ) {

							transmission *= texture2D( textures, vec3( uv, material.transmissionMap ) ).r;

						}

						// normal
						if ( material.normalMap != - 1 ) {

							vec4 tangentSample = textureSampleBarycoord(
								tangentAttribute,
								barycoord,
								faceIndices.xyz
							);

							// some provided tangents can be malformed (0, 0, 0) causing the normal to be degenerate
							// resulting in NaNs and slow path tracing.
							if ( length( tangentSample.xyz ) > 0.0 ) {

								vec3 tangent = normalize( tangentSample.xyz );
								vec3 bitangent = normalize( cross( normal, tangent ) * tangentSample.w );
								mat3 vTBN = mat3( tangent, bitangent, normal );

								vec3 texNormal = texture2D( textures, vec3( uv, material.normalMap ) ).xyz * 2.0 - 1.0;
								texNormal.xy *= material.normalScale;
								normal = vTBN * texNormal;

							}

						}

						normal *= side;

						SurfaceRec surfaceRec;
						surfaceRec.normal = normal;
						surfaceRec.faceNormal = faceNormal;
						surfaceRec.transmission = transmission;
						surfaceRec.ior = material.ior;
						surfaceRec.emission = emission;
						surfaceRec.metalness = metalness;
						surfaceRec.color = albedo.rgb;
						surfaceRec.roughness = roughness;

						// frontFace is used to determine transmissive properties and PDF. If no transmission is used
						// then we can just always assume this is a front face.
						surfaceRec.frontFace = side == 1.0 || transmission == 0.0;

						// Compute the filtered roughness value to use during specular reflection computations. A minimum
						// value of 1e-6 is needed because the GGX functions do not work with a roughness value of 0 and
						// the accumulated roughness value is scaled by a user setting and a "magic value" of 5.0.
						// If we're exiting something transmissive then scale the factor down significantly so we can retain
						// sharp internal reflections
						surfaceRec.filteredRoughness = clamp(
							max( surfaceRec.roughness, accumulatedRoughness * filterGlossyFactor * 5.0 ),
							1e-3,
							1.0
						);

						mat3 normalBasis = getBasisFromNormal( surfaceRec.normal );
						mat3 invBasis = inverse( normalBasis );

						vec3 outgoing = - normalize( invBasis * rayDirection );
						sampleRec = bsdfSample( outgoing, surfaceRec );

						float specRayPdf = specularPDF( outgoing, sampleRec.direction, surfaceRec );
						isShadowRay = sampleRec.specularPdf < rand();

						// adjust the hit point by the surface normal by a factor of some offset and the
						// maximum component-wise value of the current point to accommodate floating point
						// error as values increase.
						vec3 point = rayOrigin + rayDirection * dist;
						vec3 absPoint = abs( point );
						float maxPoint = max( absPoint.x, max( absPoint.y, absPoint.z ) );
						rayDirection = normalize( normalBasis * sampleRec.direction );

						bool isBelowSurface = dot( rayDirection, faceNormal ) < 0.0;
						rayOrigin = point + faceNormal * ( maxPoint + 1.0 ) * ( isBelowSurface ? - RAY_OFFSET : RAY_OFFSET );

						// direct env map sampling
						#if FEATURE_MIS
						{

							// find a sample in the environment map to include in the contribution
							vec3 envColor, envDirection;
							float envPdf = randomEnvMapSample( envMapInfo, envColor, envDirection );
							envDirection = invEnvironmentRotation * envDirection;

							// this env sampling is not set up for transmissive sampling and yields overly bright
							// results so we ignore the sample in this case.
							// TODO: this should be improved but how? The env samples could traverse a few layers?
							bool isSampleBelowSurface = dot( faceNormal, envDirection ) < 0.0;
							if ( isSampleBelowSurface ) {

								envPdf = 0.0;

							}

							// check if a ray could even reach the surface
							vec3 attenuatedColor;
							if (
								envPdf > 0.0 &&
								isDirectionValid( envDirection, normal, faceNormal ) &&
								! attenuateHit( bvh, rayOrigin, envDirection, bounces - i, isShadowRay, attenuatedColor )
							) {

								// get the material pdf
								vec3 sampleColor;
								float envMaterialPdf = bsdfResult( outgoing, normalize( invBasis * envDirection ), surfaceRec, sampleColor );
								if ( envMaterialPdf > 0.0 ) {

									// weight the direct light contribution
									float misWeight = misHeuristic( envPdf, envMaterialPdf );
									gl_FragColor.rgb += attenuatedColor * environmentIntensity * envColor * throughputColor * sampleColor * misWeight / envPdf;

								}

							}

						}
						#endif

						// accumulate a roughness value to offset diffuse, specular, diffuse rays that have high contribution
						// to a single pixel resulting in fireflies
						if ( ! isBelowSurface ) {

							// determine if this is a rough normal or not by checking how far off straight up it is
							vec3 halfVector = normalize( outgoing + sampleRec.direction );
							accumulatedRoughness += sin( acos( halfVector.z ) );
							transmissiveRay = false;

						}

						// accumulate color
						gl_FragColor.rgb += ( emission * throughputColor );

						// skip the sample if our PDF or ray is impossible
						if ( sampleRec.pdf <= 0.0 || ! isDirectionValid( rayDirection, normal, faceNormal) ) {

							break;

						}

						throughputColor *= sampleRec.color / sampleRec.pdf;

						// discard the sample if there are any NaNs
						if ( any( isnan( throughputColor ) ) || any( isinf( throughputColor ) ) ) {

							break;

						}

					}

					gl_FragColor.a *= opacity;

				}

			`

		} );

		this.setValues( parameters );

	}

}
