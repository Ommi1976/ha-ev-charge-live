import os
import math
from PIL import Image, ImageDraw, ImageFilter

def create_master_icon():
    size = 1024
    scale = size / 512.0
    
    # 1. Full Icon with Background
    full_img = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    
    # Base dark gradient
    bg = Image.new("RGBA", (size, size), (13, 17, 26, 255))
    bg_draw = ImageDraw.Draw(bg)
    
    for r in range(int(size * 0.72), 0, -3):
        factor = r / (size * 0.72)
        # Gradient from #202b3f (center) to #0c1018 (outer)
        red = int(12 + (32 - 12) * (1 - factor))
        green = int(16 + (43 - 16) * (1 - factor))
        blue = int(24 + (63 - 24) * (1 - factor))
        bg_draw.ellipse([size/2 - r, size/2 - r, size/2 + r, size/2 + r], fill=(red, green, blue, 255))
        
    full_img.paste(bg, (0, 0))
    
    # 2. Foreground Layer (Transparent)
    fg_img = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    
    # Glow Layer for Neon Cyan & Copper
    glow_layer = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    glow_draw = ImageDraw.Draw(glow_layer)
    
    # Outer Tech Power Ring (Subtle Cupra Copper ring with arc gap)
    cx, cy = size / 2, size / 2
    ring_r = int(370 * scale / 2)
    ring_bbox = [cx - ring_r, cy - ring_r, cx + ring_r, cy + ring_r]
    
    # Draw segmented accent arcs
    # Cyan accent arc (charging progress)
    glow_draw.arc(ring_bbox, start=120, end=350, fill=(0, 229, 255, 180), width=int(14 * scale))
    # Copper accent arc (Cupra power)
    glow_draw.arc(ring_bbox, start=-20, end=90, fill=(200, 122, 62, 220), width=int(16 * scale))
    
    # Glow blur on the ring
    ring_glow = glow_layer.filter(ImageFilter.GaussianBlur(int(10 * scale)))
    full_img = Image.alpha_composite(full_img, ring_glow)
    full_img = Image.alpha_composite(full_img, glow_layer)
    
    # 3. Dynamic Cupra Lightning Bolt
    # Coordinates normalized for 512x512
    bolt_pts = [
        (280, 75),   # Top tip
        (190, 260),  # Upper inner bend
        (265, 260),  # Middle notch
        (210, 445),  # Bottom tip
        (335, 230),  # Lower inner bend
        (260, 230),  # Upper notch
    ]
    scaled_bolt = [(x * scale, y * scale) for x, y in bolt_pts]
    
    # Intense Glow layer for bolt
    bolt_glow = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    bolt_glow_draw = ImageDraw.Draw(bolt_glow)
    bolt_glow_draw.polygon(scaled_bolt, fill=(0, 229, 255, 160))
    # Copper ambient glow
    bolt_glow_draw.line(scaled_bolt + [scaled_bolt[0]], fill=(225, 145, 80, 240), width=int(32 * scale))
    
    bolt_glow_blurred = bolt_glow.filter(ImageFilter.GaussianBlur(int(24 * scale)))
    full_img = Image.alpha_composite(full_img, bolt_glow_blurred)
    fg_img = Image.alpha_composite(fg_img, bolt_glow_blurred)
    
    # Sharp Bolt Body (Layered Copper Border + Neon Cyan Core)
    bolt_draw = ImageDraw.Draw(full_img)
    fg_draw = ImageDraw.Draw(fg_img)
    
    # Copper Outer Border
    for target in (full_img, fg_img):
        t_draw = ImageDraw.Draw(target)
        t_draw.line(scaled_bolt + [scaled_bolt[0]], fill=(215, 130, 68, 255), width=int(12 * scale), joint="curve")
        t_draw.polygon(scaled_bolt, fill=(15, 25, 38, 255))
        
        # Inner Cyan Glow gradient
        # Inner smaller bolt
        inner_pts = [
            (275 * scale, 105 * scale),
            (205 * scale, 252 * scale),
            (265 * scale, 252 * scale),
            (225 * scale, 415 * scale),
            (318 * scale, 238 * scale),
            (258 * scale, 238 * scale),
        ]
        t_draw.polygon(inner_pts, fill=(0, 229, 255, 240))
        
        # Center White Core
        core_pts = [
            (272 * scale, 135 * scale),
            (220 * scale, 248 * scale),
            (265 * scale, 248 * scale),
            (240 * scale, 385 * scale),
            (302 * scale, 242 * scale),
            (258 * scale, 242 * scale),
        ]
        t_draw.polygon(core_pts, fill=(245, 255, 255, 255))
        
        # Modern EV Accent: Dot at top right arc
        dot_cx, dot_cy = cx + ring_r * math.cos(math.radians(-25)), cy + ring_r * math.sin(math.radians(-25))
        t_draw.ellipse([dot_cx - 14 * scale, dot_cy - 14 * scale, dot_cx + 14 * scale, dot_cy + 14 * scale], fill=(0, 240, 255, 255))
        t_draw.ellipse([dot_cx - 7 * scale, dot_cy - 7 * scale, dot_cx + 7 * scale, dot_cy + 7 * scale], fill=(255, 255, 255, 255))

    return full_img, fg_img

def apply_round_mask(image):
    size = image.size
    mask = Image.new("L", size, 0)
    draw = ImageDraw.Draw(mask)
    draw.ellipse((0, 0, size[0], size[1]), fill=255)
    result = image.copy()
    result.putalpha(mask)
    return result

def apply_squircle_mask(image):
    size = image.size
    mask = Image.new("L", size, 0)
    draw = ImageDraw.Draw(mask)
    radius = int(size[0] * 0.22)
    draw.rounded_rectangle((0, 0, size[0], size[1]), radius=radius, fill=255)
    result = image.copy()
    result.putalpha(mask)
    return result

def main():
    print("Generating Master Icons...")
    full_icon, fg_icon = create_master_icon()
    
    os.makedirs("android/app/src/main/res/drawable", exist_ok=True)
    full_icon.save("android/app/src/main/res/drawable/master_icon.png")
    
    # Save 512x512 Store / Master Icon
    icon_512 = full_icon.resize((512, 512), Image.Resampling.LANCZOS)
    icon_512.save("master_icon_512.png")
    
    densities = {
        "mdpi": {"legacy": 48, "foreground": 108},
        "hdpi": {"legacy": 72, "foreground": 162},
        "xhdpi": {"legacy": 96, "foreground": 216},
        "xxhdpi": {"legacy": 144, "foreground": 324},
        "xxxhdpi": {"legacy": 192, "foreground": 432},
    }
    
    for density, sizes in densities.items():
        folder = f"android/app/src/main/res/mipmap-{density}"
        os.makedirs(folder, exist_ok=True)
        
        # Legacy square / squircle
        leg_size = sizes["legacy"]
        legacy_icon = apply_squircle_mask(full_icon.resize((leg_size, leg_size), Image.Resampling.LANCZOS))
        legacy_icon.save(os.path.join(folder, "ic_launcher.png"))
        
        # Round icon
        round_icon = apply_round_mask(full_icon.resize((leg_size, leg_size), Image.Resampling.LANCZOS))
        round_icon.save(os.path.join(folder, "ic_launcher_round.png"))
        
        # Adaptive foreground (transparent background with scaled bolt)
        fg_size = sizes["foreground"]
        # In adaptive icons, the center 66dp is visible, outer area may be cropped
        # Our fg_img has the bolt in the center 65% area, which fits adaptive safe zone perfectly!
        fg_resized = fg_icon.resize((fg_size, fg_size), Image.Resampling.LANCZOS)
        fg_resized.save(os.path.join(folder, "ic_launcher_foreground.png"))
        print(f"Generated {density}: legacy={leg_size}px, fg={fg_size}px")
        
    print("All Android launcher icons generated successfully!")

if __name__ == "__main__":
    main()
