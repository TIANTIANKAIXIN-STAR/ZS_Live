import struct, sys, glob, os

def read_boxes(data, start, end, depth=0):
    boxes = []
    i = start
    while i + 8 <= end:
        size, typ = struct.unpack('>I4s', data[i:i+8])
        typ = typ.decode('latin1')
        if size == 1:
            size = struct.unpack('>Q', data[i+8:i+16])[0]
        if size == 0:
            size = end - i
        boxes.append((i, size, typ, depth))
        if typ in ('moov','trak','mdia','minf','stbl','moof','traf','mvex'):
            boxes.extend(read_boxes(data, i+8, i+size, depth+1))
        i += size
    return boxes

files = sorted(glob.glob(sys.argv[1]))
for f in files[:4]:
    data = open(f,'rb').read()
    print(f"== {os.path.basename(f)} ({len(data)} bytes)")
    for off, size, typ, depth in read_boxes(data, 0, len(data)):
        if typ in ('ftyp','moov','moof','mdat','trak','mdia','stbl','traf','tfhd','tfdt','trun','stsd','avc1','avcC','mp4a'):
            print('  '*depth + f"{typ} @{off} sz={size}")
    # count trun samples and NAL types in mdat
    # find traf boxes, parse tfhd/trun for sample counts
    idx = 0
    while True:
        i = data.find(b'trun', idx)
        if i < 0: break
        ver_flags = data[i+4:i+8]
        scount = struct.unpack('>I', data[i+8:i+12])[0]
        print(f"  trun: samples={scount}")
        idx = i + 12
    # NAL types in mdat payloads (AVCC: 4-byte length prefixed)
    idx = 0; nal_types = {}
    while True:
        i = data.find(b'mdat', idx)
        if i < 0: break
        sz = struct.unpack('>I', data[i-4:i])[0]
        payload = data[i+4:i-4+sz]
        j = 0
        while j + 4 < len(payload):
            nlen = struct.unpack('>I', payload[j:j+4])[0]
            if nlen == 0 or j + 4 + nlen > len(payload): break
            nt = payload[j+4] & 0x1F
            nal_types[nt] = nal_types.get(nt, 0) + 1
            j += 4 + nlen
        idx = i + 4
    print(f"  NAL types: {nal_types}  (1=P,5=IDR,6=SEI,7=SPS,8=PPS)")
