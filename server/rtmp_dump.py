# Minimal RTMP pull client: connects to MediaMTX, plays a path, dumps H264 NAL stats
# usage: python rtmp_dump.py <streamKey> <seconds>
import socket, struct, sys, time

HOST, PORT = '127.0.0.1', 1935
APP = 'zslive'
KEY = sys.argv[1] if len(sys.argv) > 1 else 'inst_x'
DUR = float(sys.argv[2]) if len(sys.argv) > 2 else 15

def amf_str(s):
    b = s.encode()
    return b'\x02' + struct.pack('>H', len(b)) + b

def amf_num(n):
    return b'\x00' + struct.pack('>d', float(n))

def amf_null():
    return b'\x05'

def amf_bool(v):
    return b'\x01' + (b'\x01' if v else b'\x00')

def amf_obj(pairs):
    out = b'\x03'
    for k, v in pairs:
        kb = k.encode()
        out += struct.pack('>H', len(kb)) + kb + v
    return out + b'\x00\x00\x09'

class RTMP:
    def __init__(self):
        self.s = socket.create_connection((HOST, PORT), timeout=10)
        self.s.settimeout(5)
        self.in_chunk = 128
        self.out_chunk = 4096
        self.chunks = {}  # csid -> dict
        self.msg_stream_id = 1

    def recvn(self, n):
        d = b''
        while len(d) < n:
            p = self.s.recv(n - len(d))
            if not p: raise ConnectionError('eof')
            d += p
        return d

    def handshake(self):
        c0c1 = b'\x03' + struct.pack('>I', int(time.time())) + b'\x00'*4 + __import__('os').urandom(1528)
        self.s.sendall(c0c1)
        s0s1s2 = self.recvn(1 + 1536 + 1536)
        self.s.sendall(s0s1s2[1:1537])  # C2 = S1

    def send_msg(self, csid, typeid, msid, ts, payload):
        # fmt0 header for first chunk, fmt3 for continuations
        out = bytearray()
        off = 0
        first = True
        while off < len(payload) or first:
            n = min(self.out_chunk, len(payload) - off)
            if first:
                bh = bytes([(0 << 6) | csid])
                hdr = bh + struct.pack('>I', ts)[1:] + struct.pack('>I', len(payload))[1:] + bytes([typeid]) + struct.pack('<I', msid)
                out += hdr
                first = False
            else:
                out += bytes([(3 << 6) | csid])
            out += payload[off:off+n]
            off += n
            if len(payload) == 0: break
        self.s.sendall(bytes(out))

    def send_command(self, csid, msid, ts, *args):
        payload = b''.join(args)
        self.send_msg(csid, 20, msid, ts, payload)

    def read_chunk_stream(self):
        b0 = self.recvn(1)[0]
        fmt = b0 >> 6
        csid = b0 & 0x3F
        if csid == 0:
            csid = self.recvn(1)[0] + 64
        elif csid == 1:
            csid = self.recvn(1)[0] + self.recvn(1)[0] * 256 + 64
        st = self.chunks.get(csid, {'ts': 0, 'len': 0, 'type': 0, 'msid': 0, 'data': b''})
        if fmt == 0:
            ts = int.from_bytes(self.recvn(3), 'big')
            mlen = int.from_bytes(self.recvn(3), 'big')
            mtype = self.recvn(1)[0]
            msid = struct.unpack('<I', self.recvn(4))[0]
            st.update(ts=ts, len=mlen, type=mtype, msid=msid, data=b'')
            if ts == 0xFFFFFF: st['ts'] = struct.unpack('>I', self.recvn(4))[0]
        elif fmt == 1:
            dts = int.from_bytes(self.recvn(3), 'big')
            mlen = int.from_bytes(self.recvn(3), 'big')
            mtype = self.recvn(1)[0]
            st['ts'] += dts; st['len'] = mlen; st['type'] = mtype; st['data'] = b''
        elif fmt == 2:
            dts = int.from_bytes(self.recvn(3), 'big')
            st['ts'] += dts; st['data'] = b''
        need = st['len'] - len(st['data'])
        n = min(self.in_chunk, need)
        st['data'] += self.recvn(n)
        self.chunks[csid] = st
        if len(st['data']) >= st['len'] and st['len'] > 0:
            msg = (st['type'], st['ts'], st['msid'], st['data'])
            st['data'] = b''
            return msg
        return None

    def handle_protocol(self, typeid, data):
        if typeid == 1 and len(data) >= 4:  # set chunk size
            self.in_chunk = struct.unpack('>I', data[:4])[0]
        elif typeid == 4 and len(data) >= 2:  # user control
            ev = struct.unpack('>H', data[:2])[0]
            if ev == 0:  # stream begin
                pass

nal_hist = {}
video_tags = 0
audio_tags = 0
keyframe_flags = 0
seq_headers = 0
ts_list = []
first_dump = None

r = RTMP()
r.handshake()
conn_obj = amf_obj([('app', amf_str(APP)), ('tcUrl', amf_str(f'rtmp://{HOST}:{PORT}/{APP}')), ('type', amf_str('nonprivate'))])
r.send_command(3, 0, 0, amf_str('connect'), amf_num(1), conn_obj)
time.sleep(0.5)
r.send_command(3, 0, 0, amf_str('createStream'), amf_num(2), amf_null())
time.sleep(0.5)
r.send_command(8, 1, 0, amf_str('play'), amf_num(0), amf_null(), amf_str(KEY))

t0 = time.time()
try:
    while time.time() - t0 < DUR:
        try:
            msg = r.read_chunk_stream()
        except socket.timeout:
            continue
        if not msg: continue
        typeid, ts, msid, data = msg
        if typeid == 20:
            continue
        if typeid not in (8, 9, 18):
            r.handle_protocol(typeid, data)
            continue
        if typeid == 18:
            continue
        if typeid == 9:  # video
            video_tags += 1
            ts_list.append(ts)
            if len(data) < 5: continue
            b0, ptype = data[0], data[1]
            ft = b0 >> 4
            if ptype == 0:
                seq_headers += 1
                continue
            if ft == 1: keyframe_flags += 1
            # AVCC NALs
            i = 5
            nals = []
            while i + 4 <= len(data):
                nlen = struct.unpack('>I', data[i:i+4])[0]
                if nlen == 0 or i + 4 + nlen > len(data): break
                nt = data[i+4] & 0x1F
                nals.append(nt)
                nal_hist[nt] = nal_hist.get(nt, 0) + 1
                i += 4 + nlen
            if first_dump is None and video_tags < 50:
                first_dump = (ft, nals, len(data))
        elif typeid == 8:
            audio_tags += 1
except ConnectionError as e:
    print('connection closed:', e)

print(f"video_tags={video_tags} audio_tags={audio_tags} seq_headers={seq_headers} keyframe_flags={keyframe_flags}")
print(f"NAL histogram: {nal_hist}  (1=P 5=IDR 6=SEI 7=SPS 8=PPS 12=filler)")
print(f"first video frame: frametype/nals/size = {first_dump}")
if len(ts_list) > 2:
    diffs = [b - a for a, b in zip(ts_list, ts_list[1:])]
    bad = sum(1 for d in diffs if d < 0)
    print(f"timestamps: first={ts_list[0]} last={ts_list[-1]} negative_jumps={bad}/{len(diffs)} mindiff={min(diffs)} maxdiff={max(diffs)}")
