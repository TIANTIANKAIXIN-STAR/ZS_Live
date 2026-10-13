import sys
from PIL import Image, ImageChops

def diff_score(a_path, b_path):
    a = Image.open(a_path).convert('L')
    b = Image.open(b_path).convert('L')
    if a.size != b.size:
        return -1.0
    diff = ImageChops.difference(a, b)
    h = diff.histogram()
    total = a.size[0] * a.size[1]
    mean = sum(i * c for i, c in enumerate(h)) / total
    # 变化像素比例（灰度差>8 视为变化）
    changed = sum(c for i, c in enumerate(h) if i > 8) / total
    return mean, changed

pairs = [
    ('A_static.png', 'B_static2.png', '基线噪声(无输入)'),
    ('B_static2.png', 'C_after_W.png', 'W 键前进(键盘)'),
    ('C_after_W.png', 'D_after_look.png', '鼠标拖拽视角(鼠标)'),
]
for a, b, label in pairs:
    try:
        mean, changed = diff_score(sys.argv[1] + '/' + a, sys.argv[1] + '/' + b)
        print(f'{label}: 平均灰度差={mean:.2f} 变化像素比例={changed*100:.1f}%')
    except Exception as e:
        print(f'{label}: ERROR {e}')
