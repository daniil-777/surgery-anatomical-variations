// VISCERA 1.0.0. Unity 2022.3+/Unity 6 editor importer, no package dependency.
using System;
using System.IO;
using System.Reflection;
using UnityEditor;
using UnityEditor.AssetImporters;
using UnityEngine;
using UnityEngine.Rendering;

namespace Viscera.Editor
{
    [Serializable]
    public sealed class VisceraMeshData
    {
        public string version, name, baseColor, normal, mask;
        public float[] positions, normals, tangents, uv;
        public int[] indices;
        public float clearcoat, coatSmoothness;
    }

    public enum VisceraPipeline { Auto, BuiltIn, URP, HDRP }

    // Import after ordinary texture assets. Preserve explicit tangent frames;
    // recalculating tangents would invalidate the baked normal maps.
    [ScriptedImporter(1, "visceraunity", importQueueOffset: 100)]
    public sealed class VisceraUnityImporter : ScriptedImporter
    {
        public VisceraPipeline pipeline = VisceraPipeline.Auto;

        public override void OnImportAsset(AssetImportContext ctx)
        {
            var data = JsonUtility.FromJson<VisceraMeshData>(File.ReadAllText(ctx.assetPath));
            Validate(data);
            int count = data.positions.Length / 3;
            var vertices = new Vector3[count];
            var normals = new Vector3[count];
            var tangents = new Vector4[count];
            var uv = new Vector2[count];
            for (int i = 0; i < count; i++)
            {
                vertices[i] = new Vector3(data.positions[3*i], data.positions[3*i+1], data.positions[3*i+2]);
                normals[i] = new Vector3(data.normals[3*i], data.normals[3*i+1], data.normals[3*i+2]);
                tangents[i] = new Vector4(data.tangents[4*i], data.tangents[4*i+1], data.tangents[4*i+2], data.tangents[4*i+3]);
                uv[i] = new Vector2(data.uv[2*i], data.uv[2*i+1]);
            }
            var mesh = new Mesh { name = data.name, indexFormat = count > 65535 ? IndexFormat.UInt32 : IndexFormat.UInt16 };
            mesh.vertices = vertices;
            mesh.normals = normals;
            mesh.tangents = tangents;
            mesh.uv = uv;
            mesh.triangles = data.indices;
            mesh.RecalculateBounds();
            var material = CreateMaterial(ctx, data);
            var root = new GameObject(data.name);
            root.AddComponent<MeshFilter>().sharedMesh = mesh;
            root.AddComponent<MeshRenderer>().sharedMaterial = material;
            ctx.AddObjectToAsset("mesh", mesh);
            ctx.AddObjectToAsset("material", material);
            ctx.AddObjectToAsset("anatomy", root);
            ctx.SetMainObject(root);
        }

        static void Validate(VisceraMeshData d)
        {
            if (d == null || d.version != "viscera-unity-1.0.0" || d.positions == null || d.positions.Length < 9 || d.positions.Length % 3 != 0)
                throw new InvalidDataException("Invalid VISCERA mesh header or vertex array.");
            int n = d.positions.Length / 3;
            if (d.normals == null || d.normals.Length != n*3 || d.tangents == null || d.tangents.Length != n*4 || d.uv == null || d.uv.Length != n*2 || d.indices == null || d.indices.Length == 0 || d.indices.Length % 3 != 0)
                throw new InvalidDataException("Mismatched VISCERA mesh arrays.");
            foreach (var a in new[] { d.positions, d.normals, d.tangents, d.uv })
                foreach (float v in a)
                    if (float.IsNaN(v) || float.IsInfinity(v)) throw new InvalidDataException("Nonfinite VISCERA mesh data.");
            foreach (int i in d.indices)
                if (i < 0 || i >= n) throw new InvalidDataException("VISCERA triangle index outside vertex array.");
        }

        Texture2D LoadTexture(AssetImportContext ctx, string relative)
        {
            if (string.IsNullOrEmpty(relative) || Path.IsPathRooted(relative) || relative.Contains(".."))
                throw new InvalidDataException("Texture path must remain within the exported anatomy folder.");
            string path = (Path.GetDirectoryName(ctx.assetPath) + "/" + relative).Replace('\\', '/');
            ctx.DependsOnSourceAsset(path);
            ctx.DependsOnArtifact(path);
            var texture = AssetDatabase.LoadAssetAtPath<Texture2D>(path);
            if (texture == null) throw new InvalidDataException("Missing VISCERA texture: " + path);
            return texture;
        }

        Material CreateMaterial(AssetImportContext ctx, VisceraMeshData d)
        {
            var selected = pipeline;
            if (selected == VisceraPipeline.Auto)
            {
                var active = GraphicsSettings.currentRenderPipeline;
                string type = active == null ? "" : active.GetType().Name;
                selected = type.Contains("HDRender") ? VisceraPipeline.HDRP : type.Contains("Universal") ? VisceraPipeline.URP : VisceraPipeline.BuiltIn;
            }
            string shaderName = selected == VisceraPipeline.HDRP ? "HDRP/Lit" : selected == VisceraPipeline.URP ? "Universal Render Pipeline/Complex Lit" : "Standard";
            var shader = Shader.Find(shaderName);
            if (shader == null) throw new InvalidDataException("Install/enable the selected render pipeline. Shader unavailable: " + shaderName);
            var material = new Material(shader) { name = d.name + " Tissue", enableInstancing = true };
            var color = LoadTexture(ctx, d.baseColor);
            var normal = LoadTexture(ctx, d.normal);
            var mask = LoadTexture(ctx, d.mask);
            if (selected == VisceraPipeline.HDRP)
            {
                material.SetTexture("_BaseColorMap", color);
                material.SetColor("_BaseColor", Color.white);
                material.SetTexture("_NormalMap", normal);
                material.SetTexture("_MaskMap", mask);
                Set(material, "_MaterialID", 1);
                Set(material, "_NormalMapSpace", 0);
                Set(material, "_NormalScale", 1);
                Set(material, "_MetallicRemapMin", 0); Set(material, "_MetallicRemapMax", 1);
                Set(material, "_SmoothnessRemapMin", 0); Set(material, "_SmoothnessRemapMax", 1);
                Set(material, "_AORemapMin", 0); Set(material, "_AORemapMax", 1);
                Set(material, "_CoatMask", d.clearcoat);
                material.EnableKeyword("_NORMALMAP");
                material.EnableKeyword("_NORMALMAP_TANGENT_SPACE");
                material.EnableKeyword("_MASKMAP");
                if (d.clearcoat > 0) material.EnableKeyword("_MATERIAL_FEATURE_CLEAR_COAT");
                // Use HDRP's public validator when installed, without making
                // every built-in or URP project depend on the HDRP assembly.
                foreach (var assembly in AppDomain.CurrentDomain.GetAssemblies())
                {
                    var type = assembly.GetType("UnityEngine.Rendering.HighDefinition.HDMaterial");
                    var method = type?.GetMethod("ValidateMaterial", BindingFlags.Public | BindingFlags.Static, null, new[] { typeof(Material) }, null);
                    if (method != null) { method.Invoke(null, new object[] { material }); break; }
                }
            }
            else
            {
                bool urp = selected == VisceraPipeline.URP;
                material.SetTexture(urp ? "_BaseMap" : "_MainTex", color);
                material.SetColor(urp ? "_BaseColor" : "_Color", Color.white);
                material.SetTexture("_BumpMap", normal);
                material.SetTexture("_MetallicGlossMap", mask);
                material.SetTexture("_OcclusionMap", mask);
                Set(material, "_BumpScale", 1); Set(material, "_OcclusionStrength", 1);
                Set(material, "_Metallic", 1); Set(material, "_Smoothness", 1);
                Set(material, "_GlossMapScale", 1); Set(material, "_Glossiness", 1);
                Set(material, "_SmoothnessTextureChannel", 0);
                material.EnableKeyword("_NORMALMAP");
                material.EnableKeyword("_METALLICGLOSSMAP");
                material.EnableKeyword("_OCCLUSIONMAP");
                material.DisableKeyword("_SMOOTHNESS_TEXTURE_ALBEDO_CHANNEL_A");
                if (urp)
                {
                    Set(material, "_WorkflowMode", 1);
                    Set(material, "_ClearCoatMask", d.clearcoat);
                    Set(material, "_ClearCoatSmoothness", d.coatSmoothness);
                    if (d.clearcoat > 0) material.EnableKeyword("_CLEARCOAT");
                }
            }
            return material;
        }

        static void Set(Material m, string name, float value)
        {
            if (m.HasProperty(name)) m.SetFloat(name, value);
        }
    }

    public sealed class VisceraTextureImporter : AssetPostprocessor
    {
        void OnPreprocessTexture()
        {
            // Restrict to this export layout; never modify unrelated textures.
            if (!assetPath.Contains("/VISCERA/Exports/") || !assetPath.Contains("/Textures/Viscera_")) return;
            string name = Path.GetFileNameWithoutExtension(assetPath);
            bool isColor = name == "Viscera_BaseColor";
            bool isNormal = name == "Viscera_Normal";
            if (!isColor && !isNormal && name != "Viscera_Mask") return;
            var importer = (TextureImporter)assetImporter;
            importer.textureType = isNormal ? TextureImporterType.NormalMap : TextureImporterType.Default;
            importer.sRGBTexture = isColor;
            importer.maxTextureSize = 4096;
            importer.textureCompression = TextureImporterCompression.Uncompressed;
            importer.mipmapEnabled = true;
            importer.streamingMipmaps = false;
            importer.isReadable = false;
            importer.wrapMode = TextureWrapMode.Clamp;
            importer.filterMode = FilterMode.Trilinear;
            importer.anisoLevel = 8;
            importer.alphaSource = TextureImporterAlphaSource.FromInput;
            importer.alphaIsTransparency = false;
            importer.convertToNormalmap = false;
            importer.flipGreenChannel = false;
        }
    }
}
