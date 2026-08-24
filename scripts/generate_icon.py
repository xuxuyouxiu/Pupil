"""Pupil App Icon Generator v2
Better proportions: bigger eyes, correct smile, balanced composition
"""
from PIL import Image, ImageDraw

SCALE = 4
BASE = 512
S = BASE * SCALE

# Colors
BG_DARK = (5, 5, 8, 255)           # #050508 - very dark background
BALL = (13, 17, 23, 255)           # #0D1117 - ball surface
RING_BLUE = (55, 138, 221, 255)    # #378ADD - monitoring ring
EYE_WHITE = (240, 246, 252, 255)   # #F0F6FC - eye white
EYE_DARK = (13, 17, 23, 255)      # #0D1117 - pupil
HIGHLIGHT = (255, 255, 255, 220)   # bright white highlight

def draw_icon(size):
    s = size * SCALE
    img = Image.new('RGBA', (s, s), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)
    cx, cy = s // 2, s // 2

    # 1. Background: dark rounded square
    corner = int(s * 0.188)
    d.rounded_rectangle([0, 0, s - 1, s - 1], radius=corner, fill=BG_DARK)

    # 2. Blue monitoring ring (slightly thinner, elegant)
    ring_r = int(s * 0.352)      # ~180/512
    ring_w = max(2, int(s * 0.020))  # ~10/512
    d.ellipse(
        [cx - ring_r, cy - ring_r, cx + ring_r, cy + ring_r],
        outline=RING_BLUE, width=ring_w
    )

    # 3. Ball sphere (fills most of the ring, darker for contrast)
    ball_r = int(s * 0.328)      # ~168/512
    d.ellipse(
        [cx - ball_r, cy - ball_r, cx + ball_r, cy + ball_r],
        fill=BALL
    )

    # 4. Eyes — MUCH BIGGER, positioned upper half of ball
    # Eye vertical position: slightly above center (classic face position)
    eye_y = cy - int(s * 0.055)   # ~28/512 above center
    eye_rx = int(s * 0.039)       # ~20/512
    eye_ry = int(s * 0.047)       # ~24/512
    eye_gap = int(s * 0.070)      # ~36/512 between centers

    for sign in [-1, 1]:
        ex = cx + sign * eye_gap
        ey = eye_y

        # Eye white (big white oval)
        d.ellipse(
            [ex - eye_rx, ey - eye_ry, ex + eye_rx, ey + eye_ry],
            fill=EYE_WHITE
        )

        # Pupil (large, looking slightly inward for cute effect)
        pupil_r = int(s * 0.025)     # ~13/512
        px = ex - sign * int(s * 0.006)  # slight inward gaze
        py = ey - int(s * 0.008)         # slight upward gaze
        d.ellipse(
            [px - pupil_r, py - pupil_r, px + pupil_r, py + pupil_r],
            fill=EYE_DARK
        )

        # Bright highlight (top-left of pupil, gives "life")
        hl_r = int(s * 0.009)        # ~4.5/512
        hl_x = px - int(s * 0.006)
        hl_y = py - int(s * 0.008)
        d.ellipse(
            [hl_x - hl_r, hl_y - hl_r, hl_x + hl_r, hl_y + hl_r],
            fill=HIGHLIGHT
        )

    # 5. Smile — simple upward arc using multiple lines for smoothness
    smile_y = cy + int(s * 0.078)
    smile_r = int(s * 0.045)       # ~23/512
    smile_w = max(2, int(s * 0.005))
    # Draw smile as a curve: use arc that curves upward
    # The arc should be centered below the smile line, so the arc bows UP
    smile_arc = Image.new('RGBA', (s, s), (0, 0, 0, 0))
    d_arc = ImageDraw.Draw(smile_arc)
    # Draw a circular arc from 200° to 340°... wait, that's a frown
    # For a smile: the center should be BELOW the arc, so the arc bows UP
    # Let's use a simple arc approach: center at (cx, smile_y + smile_r), arc from 20° to 160°
    d_arc.arc(
        [cx - smile_r, smile_y - smile_r, cx + smile_r, smile_y + smile_r],
        start=20, end=160, fill=(240, 246, 252, 80), width=smile_w
    )
    img = Image.alpha_composite(img, smile_arc)

    # 6. Cheek blushes (subtle, very light pink/cyan tint on cheeks)
    blush = Image.new('RGBA', (s, s), (0, 0, 0, 0))
    d_blush = ImageDraw.Draw(blush)
    for sign in [-1, 1]:
        bx = cx + sign * int(s * 0.08)   # ~41/512
        by = cy + int(s * 0.04)            # ~20/512
        br = int(s * 0.02)                  # ~10/512
        d_blush.ellipse(
            [bx - br, by - br, bx + br, by + br],
            fill=(55, 138, 221, 40)  # subtle blue tint
        )
    img = Image.alpha_composite(img, blush)

    return img.resize((size, size), Image.LANCZOS)


def main():
    import os
    out_dir = os.path.dirname(os.path.abspath(__file__))
    parent = os.path.dirname(out_dir)
    resources = os.path.join(parent, 'resources')
    os.makedirs(resources, exist_ok=True)

    # Master 512x512 PNG
    icon_512 = draw_icon(512)
    png_path = os.path.join(resources, 'icon.png')
    icon_512.save(png_path, 'PNG')
    print(f'Saved: {png_path}')

    # ICO with all standard sizes
    ico_sizes = [(16, 16), (32, 32), (48, 48), (64, 64), (128, 128), (256, 256)]
    ico_path = os.path.join(resources, 'icon.ico')
    icon_512.save(ico_path, format='ICO', sizes=ico_sizes)
    print(f'Saved: {ico_path}')

    # Individual PNGs for reference
    for sz in [256, 128, 64, 32, 16]:
        img = draw_icon(sz)
        p = os.path.join(resources, f'icon-{sz}.png')
        img.save(p, 'PNG')
        print(f'Saved: {p}')

    print('\nAll icons generated successfully.')


if __name__ == '__main__':
    main()
