using System;
using System.Collections.Generic;
using System.ComponentModel;
using System.Diagnostics;
using System.Globalization;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;

namespace BianQian
{
    public static class NativeAppResources
    {
        private const int IconType = 3, GroupIconType = 14, VersionType = 16;
        private const ushort DefaultLanguage = 1033, UnicodeCodePage = 1200;
        private const uint LoadAsDataFile = 0x00000002, LoadAsImageResource = 0x00000020;

        private delegate bool ResourceNamesCallback(IntPtr module, IntPtr type, IntPtr name, IntPtr parameter);
        private delegate bool ResourceLanguagesCallback(IntPtr module, IntPtr type, IntPtr name, ushort language, IntPtr parameter);

        [DllImport("kernel32.dll", CharSet = CharSet.Unicode, ExactSpelling = true, SetLastError = true)]
        private static extern IntPtr LoadLibraryExW(string fileName, IntPtr reserved, uint flags);
        [DllImport("kernel32.dll", SetLastError = true)]
        [return: MarshalAs(UnmanagedType.Bool)]
        private static extern bool FreeLibrary(IntPtr module);
        [DllImport("kernel32.dll", CharSet = CharSet.Unicode, ExactSpelling = true, SetLastError = true)]
        [return: MarshalAs(UnmanagedType.Bool)]
        private static extern bool EnumResourceNamesW(IntPtr module, IntPtr type, ResourceNamesCallback callback, IntPtr parameter);
        [DllImport("kernel32.dll", CharSet = CharSet.Unicode, ExactSpelling = true, SetLastError = true)]
        [return: MarshalAs(UnmanagedType.Bool)]
        private static extern bool EnumResourceLanguagesW(IntPtr module, IntPtr type, IntPtr name, ResourceLanguagesCallback callback, IntPtr parameter);
        [DllImport("kernel32.dll", CharSet = CharSet.Unicode, ExactSpelling = true, SetLastError = true)]
        private static extern IntPtr BeginUpdateResourceW(string fileName, [MarshalAs(UnmanagedType.Bool)] bool deleteExisting);
        [DllImport("kernel32.dll", CharSet = CharSet.Unicode, ExactSpelling = true, SetLastError = true)]
        [return: MarshalAs(UnmanagedType.Bool)]
        private static extern bool UpdateResourceW(IntPtr update, IntPtr type, IntPtr name, ushort language, byte[] data, uint size);
        [DllImport("kernel32.dll", CharSet = CharSet.Unicode, ExactSpelling = true, SetLastError = true)]
        [return: MarshalAs(UnmanagedType.Bool)]
        private static extern bool EndUpdateResourceW(IntPtr update, [MarshalAs(UnmanagedType.Bool)] bool discard);
        [DllImport("kernel32.dll", CharSet = CharSet.Unicode, ExactSpelling = true, SetLastError = true)]
        private static extern IntPtr FindResourceExW(IntPtr module, IntPtr type, IntPtr name, ushort language);
        [DllImport("kernel32.dll", SetLastError = true)]
        private static extern uint SizeofResource(IntPtr module, IntPtr resource);
        [DllImport("kernel32.dll", SetLastError = true)]
        private static extern IntPtr LoadResource(IntPtr module, IntPtr resource);
        [DllImport("kernel32.dll", SetLastError = true)]
        private static extern IntPtr LockResource(IntPtr resourceData);

        private sealed class ResourceName
        {
            public int Number;
            public string Text;
            public bool IsNumber { get { return Text == null; } }
            public string Key { get { return IsNumber ? "#" + Number : "$" + Text; } }
            public static ResourceName FromPointer(IntPtr pointer)
            {
                ulong address = unchecked((ulong)pointer.ToInt64());
                return (address >> 16) == 0
                    ? new ResourceName { Number = (int)address }
                    : new ResourceName { Text = Marshal.PtrToStringUni(pointer) };
            }
            public IntPtr Allocate() { return IsNumber ? new IntPtr(Number) : Marshal.StringToHGlobalUni(Text); }
            public void Release(IntPtr pointer) { if (!IsNumber) Marshal.FreeHGlobal(pointer); }
        }

        private sealed class ResourceEntry
        {
            public int Type;
            public ResourceName Name;
            public ushort Language;
            public string Key { get { return Type + ":" + Name.Key + ":" + Language; } }
        }

        private sealed class IconFrame
        {
            public byte Width, Height, Colors;
            public ushort Planes, BitCount;
            public byte[] Data;
        }

        public sealed class Result
        {
            public int IconFrames, IconResources, IconGroups, VersionResources;
            public string ProductName, ProductVersion;
        }

        private static Exception NativeError(string operation, int error)
        {
            return new Win32Exception(error, operation + " failed (Win32 error " + error + "): " + new Win32Exception(error).Message);
        }

        private static IntPtr OpenResources(string fileName)
        {
            IntPtr module = LoadLibraryExW(fileName, IntPtr.Zero, LoadAsDataFile | LoadAsImageResource);
            if (module == IntPtr.Zero) throw NativeError("LoadLibraryExW", Marshal.GetLastWin32Error());
            return module;
        }

        private static void CloseResources(IntPtr module)
        {
            if (!FreeLibrary(module)) throw NativeError("FreeLibrary", Marshal.GetLastWin32Error());
        }

        private static List<ResourceEntry> Enumerate(IntPtr module, int type)
        {
            List<ResourceEntry> entries = new List<ResourceEntry>();
            Exception callbackError = null;
            ResourceNamesCallback names = delegate(IntPtr loaded, IntPtr kind, IntPtr name, IntPtr parameter)
            {
                try
                {
                    ResourceName copiedName = ResourceName.FromPointer(name);
                    ResourceLanguagesCallback languages = delegate(IntPtr ignoredModule, IntPtr ignoredType, IntPtr ignoredName, ushort language, IntPtr ignoredParameter)
                    {
                        entries.Add(new ResourceEntry { Type = type, Name = copiedName, Language = language });
                        return true;
                    };
                    if (!EnumResourceLanguagesW(loaded, kind, name, languages, IntPtr.Zero))
                    {
                        callbackError = NativeError("EnumResourceLanguagesW", Marshal.GetLastWin32Error());
                        return false;
                    }
                    return true;
                }
                catch (Exception error) { callbackError = error; return false; }
            };
            bool success = EnumResourceNamesW(module, new IntPtr(type), names, IntPtr.Zero);
            int code = Marshal.GetLastWin32Error();
            if (callbackError != null) throw callbackError;
            if (!success && code != 1813 && code != 1812) throw NativeError("EnumResourceNamesW", code);
            return entries;
        }

        private static void Update(IntPtr update, ResourceEntry entry, byte[] bytes)
        {
            IntPtr name = entry.Name.Allocate();
            try
            {
                if (!UpdateResourceW(update, new IntPtr(entry.Type), name, entry.Language, bytes, bytes == null ? 0U : checked((uint)bytes.Length)))
                    throw NativeError("UpdateResourceW " + entry.Key, Marshal.GetLastWin32Error());
            }
            finally { entry.Name.Release(name); }
        }

        private static byte[] ReadResource(IntPtr module, ResourceEntry entry)
        {
            IntPtr name = entry.Name.Allocate();
            try
            {
                IntPtr resource = FindResourceExW(module, new IntPtr(entry.Type), name, entry.Language);
                if (resource == IntPtr.Zero) throw NativeError("FindResourceExW " + entry.Key, Marshal.GetLastWin32Error());
                uint size = SizeofResource(module, resource);
                if (size == 0) throw NativeError("SizeofResource " + entry.Key, Marshal.GetLastWin32Error());
                IntPtr loaded = LoadResource(module, resource);
                if (loaded == IntPtr.Zero) throw NativeError("LoadResource " + entry.Key, Marshal.GetLastWin32Error());
                IntPtr data = LockResource(loaded);
                if (data == IntPtr.Zero) throw new InvalidDataException("LockResource returned null: " + entry.Key);
                byte[] bytes = new byte[checked((int)size)];
                Marshal.Copy(data, bytes, 0, bytes.Length);
                return bytes;
            }
            finally { entry.Name.Release(name); }
        }

        private static List<IconFrame> ReadIcon(string fileName)
        {
            byte[] file = File.ReadAllBytes(fileName);
            List<IconFrame> frames = new List<IconFrame>();
            using (BinaryReader reader = new BinaryReader(new MemoryStream(file)))
            {
                if (file.Length < 6 || reader.ReadUInt16() != 0 || reader.ReadUInt16() != 1) throw new InvalidDataException("Icon file is not a Windows ICO.");
                int count = reader.ReadUInt16();
                if (count < 1 || count > 256 || file.Length < 6 + count * 16) throw new InvalidDataException("Invalid ICO directory length.");
                for (int index = 0; index < count; index++)
                {
                    IconFrame frame = new IconFrame();
                    frame.Width = reader.ReadByte(); frame.Height = reader.ReadByte(); frame.Colors = reader.ReadByte();
                    if (reader.ReadByte() != 0) throw new InvalidDataException("Invalid ICO entry reserved byte.");
                    frame.Planes = reader.ReadUInt16(); frame.BitCount = reader.ReadUInt16();
                    uint size = reader.ReadUInt32(), offset = reader.ReadUInt32();
                    if (size < 24 || offset < 6 + count * 16 || (ulong)offset + size > (ulong)file.Length) throw new InvalidDataException("ICO frame lies outside the file.");
                    frame.Data = new byte[checked((int)size)];
                    Buffer.BlockCopy(file, checked((int)offset), frame.Data, 0, frame.Data.Length);
                    byte[] signature = { 137, 80, 78, 71, 13, 10, 26, 10 };
                    for (int n = 0; n < signature.Length; n++) if (frame.Data[n] != signature[n]) throw new InvalidDataException("This icon helper expects PNG-compressed ICO frames.");
                    if (ReadBigEndian(frame.Data, 16) != (frame.Width == 0 ? 256U : frame.Width) || ReadBigEndian(frame.Data, 20) != (frame.Height == 0 ? 256U : frame.Height))
                        throw new InvalidDataException("ICO directory and PNG dimensions disagree.");
                    frames.Add(frame);
                }
            }
            return frames;
        }

        private static uint ReadBigEndian(byte[] data, int offset)
        {
            return ((uint)data[offset] << 24) | ((uint)data[offset + 1] << 16) | ((uint)data[offset + 2] << 8) | data[offset + 3];
        }

        private static byte[] BuildGroup(List<IconFrame> frames)
        {
            using (MemoryStream stream = new MemoryStream())
            using (BinaryWriter writer = new BinaryWriter(stream))
            {
                writer.Write((ushort)0); writer.Write((ushort)1); writer.Write((ushort)frames.Count);
                for (int index = 0; index < frames.Count; index++)
                {
                    IconFrame frame = frames[index];
                    writer.Write(frame.Width); writer.Write(frame.Height); writer.Write(frame.Colors); writer.Write((byte)0);
                    writer.Write(frame.Planes); writer.Write(frame.BitCount); writer.Write((uint)frame.Data.Length); writer.Write((ushort)(index + 1));
                }
                return stream.ToArray();
            }
        }

        private static void Align(BinaryWriter writer)
        {
            while ((writer.BaseStream.Position & 3) != 0) writer.Write((byte)0);
        }

        private static byte[] Block(string key, ushort type, byte[] value, ushort valueLength, List<byte[]> children)
        {
            using (MemoryStream stream = new MemoryStream())
            using (BinaryWriter writer = new BinaryWriter(stream))
            {
                writer.Write((ushort)0); writer.Write(valueLength); writer.Write(type);
                writer.Write(Encoding.Unicode.GetBytes(key + "\0")); Align(writer);
                if (value != null) writer.Write(value);
                if (children != null) foreach (byte[] child in children) { Align(writer); writer.Write(child); }
                if (stream.Length > UInt16.MaxValue) throw new InvalidDataException("Version resource block is too large.");
                ushort length = (ushort)stream.Length;
                stream.Position = 0; writer.Write(length);
                return stream.ToArray();
            }
        }

        private static ushort[] ParseVersion(string version)
        {
            string[] parts = version.Split('.');
            if (parts.Length != 3 && parts.Length != 4) throw new ArgumentException("ProductVersion must contain three or four integer components.");
            ushort[] result = new ushort[4];
            for (int index = 0; index < parts.Length; index++)
                if (!UInt16.TryParse(parts[index], NumberStyles.None, CultureInfo.InvariantCulture, out result[index])) throw new ArgumentException("ProductVersion components must be integers between 0 and 65535.");
            return result;
        }

        private static byte[] BuildVersion(string name, string version, string originalFileName, ushort[] components, SortedSet<ushort> languages)
        {
            byte[] fixedInfo;
            using (MemoryStream stream = new MemoryStream())
            using (BinaryWriter writer = new BinaryWriter(stream))
            {
                uint ms = ((uint)components[0] << 16) | components[1], ls = ((uint)components[2] << 16) | components[3];
                foreach (uint value in new uint[] { 0xFEEF04BDU, 0x00010000U, ms, ls, ms, ls, 0x3FU, 0U, 0x00040004U, 1U, 0U, 0U, 0U }) writer.Write(value);
                fixedInfo = stream.ToArray();
            }
            Dictionary<string, string> strings = new Dictionary<string, string>();
            strings.Add("ProductName", name); strings.Add("FileDescription", name); strings.Add("InternalName", name);
            strings.Add("OriginalFilename", originalFileName); strings.Add("FileVersion", version); strings.Add("ProductVersion", version);
            List<byte[]> tables = new List<byte[]>();
            byte[] translations;
            using (MemoryStream stream = new MemoryStream())
            using (BinaryWriter writer = new BinaryWriter(stream))
            {
                foreach (ushort language in languages)
                {
                    List<byte[]> values = new List<byte[]>();
                    foreach (KeyValuePair<string, string> item in strings)
                        values.Add(Block(item.Key, 1, Encoding.Unicode.GetBytes(item.Value + "\0"), checked((ushort)(item.Value.Length + 1)), null));
                    tables.Add(Block(language.ToString("X4", CultureInfo.InvariantCulture) + UnicodeCodePage.ToString("X4", CultureInfo.InvariantCulture), 1, null, 0, values));
                    writer.Write(language); writer.Write(UnicodeCodePage);
                }
                translations = stream.ToArray();
            }
            byte[] stringInfo = Block("StringFileInfo", 1, null, 0, tables);
            byte[] translation = Block("Translation", 0, translations, checked((ushort)translations.Length), null);
            byte[] variableInfo = Block("VarFileInfo", 1, null, 0, new List<byte[]> { translation });
            return Block("VS_VERSION_INFO", 0, fixedInfo, checked((ushort)fixedInfo.Length), new List<byte[]> { stringInfo, variableInfo });
        }

        private static ResourceEntry Entry(int type, int number, ushort language)
        {
            return new ResourceEntry { Type = type, Name = new ResourceName { Number = number }, Language = language };
        }

        private static void AssertBytes(byte[] expected, byte[] actual, string label)
        {
            if (expected.Length != actual.Length) throw new InvalidDataException("Resource read-back length mismatch: " + label);
            for (int index = 0; index < expected.Length; index++) if (expected[index] != actual[index]) throw new InvalidDataException("Resource read-back bytes mismatch: " + label);
        }

        private static void AssertEntries(List<ResourceEntry> expected, List<ResourceEntry> actual, string label)
        {
            HashSet<string> keys = new HashSet<string>();
            foreach (ResourceEntry entry in expected) keys.Add(entry.Key);
            if (keys.Count != actual.Count) throw new InvalidDataException("Unexpected resource count after update: " + label);
            foreach (ResourceEntry entry in actual) if (!keys.Contains(entry.Key)) throw new InvalidDataException("Unexpected resource after update: " + entry.Key);
        }

        public static Result Write(string executablePath, string iconPath, string productName, string productVersion)
        {
            executablePath = Path.GetFullPath(executablePath); iconPath = Path.GetFullPath(iconPath);
            if (!File.Exists(executablePath)) throw new FileNotFoundException("Executable does not exist.", executablePath);
            if (String.IsNullOrWhiteSpace(productName) || productName.IndexOf('\0') >= 0) throw new ArgumentException("ProductName must be nonempty and contain no null characters.");
            ushort[] version = ParseVersion(productVersion);
            List<IconFrame> frames = ReadIcon(iconPath);
            List<ResourceEntry> groups, oldIcons, versions;
            IntPtr module = OpenResources(executablePath);
            try { groups = Enumerate(module, GroupIconType); oldIcons = Enumerate(module, IconType); versions = Enumerate(module, VersionType); }
            finally { CloseResources(module); }
            if (groups.Count == 0) groups.Add(Entry(GroupIconType, 1, DefaultLanguage));
            if (versions.Count == 0) versions.Add(Entry(VersionType, 1, DefaultLanguage));
            SortedSet<ushort> iconLanguages = new SortedSet<ushort>(), versionLanguages = new SortedSet<ushort>();
            foreach (ResourceEntry group in groups) iconLanguages.Add(group.Language);
            foreach (ResourceEntry resource in versions) versionLanguages.Add(resource.Language);
            versionLanguages.Add(DefaultLanguage);
            byte[] groupBytes = BuildGroup(frames), versionBytes = BuildVersion(productName, productVersion, Path.GetFileName(executablePath), version, versionLanguages);
            List<ResourceEntry> icons = new List<ResourceEntry>();
            foreach (ushort language in iconLanguages) for (int index = 0; index < frames.Count; index++) icons.Add(Entry(IconType, index + 1, language));

            IntPtr update = BeginUpdateResourceW(executablePath, false);
            if (update == IntPtr.Zero) throw NativeError("BeginUpdateResourceW", Marshal.GetLastWin32Error());
            try
            {
                // Retain every original group name/language, but replace all referenced
                // images. Explorer cannot fall back to a surviving Electron icon.
                foreach (ResourceEntry icon in oldIcons) Update(update, icon, null);
                foreach (ResourceEntry icon in icons) Update(update, icon, frames[icon.Name.Number - 1].Data);
                foreach (ResourceEntry group in groups) Update(update, group, groupBytes);
                foreach (ResourceEntry resource in versions) Update(update, resource, versionBytes);
                IntPtr committing = update; update = IntPtr.Zero;
                if (!EndUpdateResourceW(committing, false)) throw NativeError("EndUpdateResourceW", Marshal.GetLastWin32Error());
            }
            catch (Exception original)
            {
                if (update != IntPtr.Zero && !EndUpdateResourceW(update, true))
                    throw new InvalidOperationException(original.Message + "; discard failed: " + NativeError("EndUpdateResourceW(discard)", Marshal.GetLastWin32Error()).Message);
                throw;
            }

            module = OpenResources(executablePath);
            try
            {
                AssertEntries(groups, Enumerate(module, GroupIconType), "RT_GROUP_ICON");
                AssertEntries(icons, Enumerate(module, IconType), "RT_ICON");
                AssertEntries(versions, Enumerate(module, VersionType), "RT_VERSION");
                foreach (ResourceEntry group in groups) AssertBytes(groupBytes, ReadResource(module, group), group.Key);
                foreach (ResourceEntry icon in icons) AssertBytes(frames[icon.Name.Number - 1].Data, ReadResource(module, icon), icon.Key);
                foreach (ResourceEntry resource in versions) AssertBytes(versionBytes, ReadResource(module, resource), resource.Key);
            }
            finally { CloseResources(module); }
            FileVersionInfo info = FileVersionInfo.GetVersionInfo(executablePath);
            if (info.ProductName != productName || info.FileDescription != productName || info.InternalName != productName || info.OriginalFilename != Path.GetFileName(executablePath) || info.FileVersion != productVersion || info.ProductVersion != productVersion ||
                info.FileMajorPart != version[0] || info.FileMinorPart != version[1] || info.FileBuildPart != version[2] || info.FilePrivatePart != version[3] ||
                info.ProductMajorPart != version[0] || info.ProductMinorPart != version[1] || info.ProductBuildPart != version[2] || info.ProductPrivatePart != version[3])
                throw new InvalidDataException("FileVersionInfo read-back does not match the requested product name or version.");
            return new Result { IconFrames = frames.Count, IconResources = icons.Count, IconGroups = groups.Count, VersionResources = versions.Count, ProductName = productName, ProductVersion = productVersion };
        }
    }
}
