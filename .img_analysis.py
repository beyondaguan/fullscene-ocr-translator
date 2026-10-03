import struct, zlib

def read_png(path):
    with open(path, 'rb') as f:
        data = f.read()
    # 解析 IHDR
    w, h = struct.unpack('>II', data[16:24])
    bit_depth = data[24]
    color_type = data[25]
    print(f'尺寸: {w}x{h}, bit_depth={bit_depth}, color_type={color_type}')
    return w, h, color_type

p = r'C:/Users/Administrator/.workbuddy/clipboard-images/clipboard-2026-09-29T12-40-02-811Z-e8cce9d4.png'
w, h, ct = read_png(p)
