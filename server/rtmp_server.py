# Minimal RTMP publish server: accepts one publish from UE StreamForge, dumps NAL stats
# usage: python rtmp_server.py [seconds]
import socket, struct, sys, time, os

PORT = 1936
DUR = float(sys.argv[1]) if len(sys.argv) > 1 else 20

def amf_str(s):
    b = s.encode() if isinstance(s, str) else s
    return b'\x02' + struct.pack('>H', len(b)) + b

def amf_num(n):
    return b'\x00' + struct.pack('>d', float(n))

def amf_null():
    return b'\x05'

def amf_obj_end():
    return b'\x00\x00\x09'

srv = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
srv.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
srv.bind(('127.0.0.1', PORT))
srv.listen(1)
srv.settimeout(DUR + 30)
print(f'listening on {PORT}', flush=True)
s, addr = srv.accept()
s.settimeout(10)
print('conn from', addr, flush=True)

def recvn(n):
    d = b''
    while len(d) < n:
        p = s.recv(n - len(d))
        if not p: raise ConnectionError('eof')
        d += p
    return d

# handshake: read C0C1, send S0S1S2, read C2
c0c1 = recvn(1537)
s.sendall(b'\x03' + b'\x00'*4 + b'\x01\x02\x03\x04' + os.urandom(1528) + b'\x00'*4 + b'\x05\x06\x07\x08' + os.urandom(1528))
c2 = recvn(1536)

in_chunk = 128
out_chunk = 4096
chunks = {}

def send_msg(csid, typeid, msid, ts, payload):
    out = bytearray()
    off = 0
    first = True
    while off < len(payload) or first:
        n = min(out_chunk, len(payload) - off)
        if first:
            out += bytes([(0 << 6) | csid]) + struct.pack('>I', ts)[1:] + struct.pack('>I', len(payload))[1:] + bytes([typeid]) + struct.pack('<I', msid)
            first = False
        else:
            out += bytes([(3 << 6) | csid])
        out += payload[off:off+n]
        off += n
        if len(payload) == 0: break
    s.sendall(bytes(out))

def read_msg():
    while True:
        b0 = recvn(1)[0]
        fmt = b0 >> 6
        csid = b0 & 0x3F
        if csid == 0: csid = recvn(1)[0] + 64
        elif csid == 1: csid = recvn(1)[0] + recvn(1)[0]*256 + 64
        st = chunks.get(csid, {'ts':0,'len':0,'type':0,'msid':0,'data':b''})
        if fmt == 0:
            ts = int.from_bytes(recvn(3),'big')
            mlen = int.from_bytes(recvn(3),'big')
            mtype = recvn(1)[0]
            msid = struct.unpack('<I', recvn(4))[0]
            st.update(ts=ts, len=mlen, type=mtype, msid=msid, data=b'')
            if ts == 0xFFFFFF: st['ts'] = struct.unpack('>I', recvn(4))[0]
        elif fmt == 1:
            dts = int.from_bytes(recvn(3),'big')
            mlen = int.from_bytes(recvn(3),'big')
            mtype = recvn(1)[0]
            st['ts'] += dts; st['len'] = mlen; st['type'] = mtype; st['data'] = b''
            if dts == 0xFFFFFF: recvn(4)
        elif fmt == 2:
            dts = int.from_bytes(recvn(3),'big')
            st['ts'] += dts; st['data'] = b''
            if dts == 0xFFFFFF: recvn(4)
        need = st['len'] - len(st['data'])
        st['data'] += recvn(min(in_chunk, need))
        chunks[csid] = st
        if st['len'] > 0 and len(st['data']) >= st['len']:
            msg = (st['type'], st['ts'], st['msid'], st['data'])
            st['data'] = b''
            return msg

def parse_amf(data):
    # crude: extract first command string and txn id
    cmd = None
    if len(data) > 3 and data[0] == 2:
        sl = struct.unpack('>H', data[1:3])[0]
        cmd = data[3:3+sl].decode('latin1')
    txn = 0
    i = 3 + (len(cmd) if cmd else 0)
    if i < len(data) and data[i] == 0:
        txn = struct.unpack('>d', data[i+1:i+9])[0]
    return cmd, txn

nal_hist = {}
video_tags = audio_tags = 0
keyframe_flags = 0
seq_headers = 0
frame_samples = []
ts_list = []

t0 = time.time()
published = False
try:
    while time.time() - t0 < DUR:
        try:
            typeid, ts, msid, data = read_msg()
        except socket.timeout:
            continue
        if typeid == 1 and len(data) >= 4:
            in_chunk = struct.unpack('>I', data[:4])[0]
            continue
        if typeid == 20:
            cmd, txn = parse_amf(data)
            print(f'cmd: {cmd} txn={txn}', flush=True)
            if cmd == 'connect':
                # window ack size + set peer bandwidth + set chunk size + _result
                send_msg(2, 5, 0, 0, struct.pack('>I', 2500000))
                send_msg(2, 6, 0, 0, struct.pack('>I', 2500000) + b'\x02')
                send_msg(2, 1, 0, 0, struct.pack('>I', out_chunk))
                props = b'\x03' + b'\x00\x08fmsVer' + amf_str('FMS/3,0,1,123') + b'\x00\x0ccapabilities' + amf_num(31) + b'\x00\x00\x09'
                info = b'\x03' + b'\x00\x05level' + amf_str('status') + b'\x00\x04code' + amf_str('NetConnection.Connect.Success') + b'\x00\x00\x09'
                send_msg(3, 20, 0, 0, amf_str('_result') + amf_num(txn) + props + info)
            elif cmd == 'createStream':
                send_msg(3, 20, 0, 0, amf_str('_result') + amf_num(txn) + amf_null() + amf_num(1))
            elif cmd == 'publish':
                published = True
                info = b'\x03' + b'\x00\x05level' + amf_str('status') + b'\x00\x04code' + amf_str('NetStream.Publish.Start') + b'\x00\x00\x09'
                send_msg(5, 20, 1, 0, amf_str('onStatus') + amf_num(0) + amf_null() + info)
                print('PUBLISH started', flush=True)
            continue
        if typeid == 9:
            video_tags += 1
            ts_list.append(ts)
            if len(data) < 5: continue
            b0, ptype = data[0], data[1]
            ft = b0 >> 4
            if ptype == 0:
                seq_headers += 1
                continue
            if ft == 1: keyframe_flags += 1
            i = 5
            nals = []
            while i + 4 <= len(data):
                nlen = struct.unpack('>I', data[i:i+4])[0]
                if nlen == 0 or i + 4 + nlen > len(data): break
                nt = data[i+4] & 0x1F
                nals.append(nt)
                nal_hist[nt] = nal_hist.get(nt, 0) + 1
                i += 4 + nlen
            if len(frame_samples) < 12:
                frame_samples.append((ft, nals, len(data), ts))
        elif typeid == 8:
            audio_tags += 1
except ConnectionError as e:
    print('closed:', e)

print(f"\nvideo_tags={video_tags} audio_tags={audio_tags} seq_headers={seq_headers} keyframe_flags={keyframe_flags}")
print(f"NAL histogram: {nal_hist}  (1=P 5=IDR 6=SEI 7=SPS 8=PPS 9=AUD 12=filler)")
print("first frames (frametype, nals, size, ts):")
for f in frame_samples: print(' ', f)
if len(ts_list) > 2:
    diffs = [b-a for a,b in zip(ts_list, ts_list[1:])]
    bad = sum(1 for d in diffs if d < 0)
    print(f"ts: first={ts_list[0]} last={ts_list[-1]} neg={bad}/{len(diffs)} min={min(diffs)} max={max(diffs)}")
