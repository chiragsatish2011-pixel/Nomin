---
name: Quiet Studio
colors:
  surface: '#fcf9f8'
  surface-dim: '#dcd9d9'
  surface-bright: '#fcf9f8'
  surface-container-lowest: '#ffffff'
  surface-container-low: '#f6f3f2'
  surface-container: '#f0eded'
  surface-container-high: '#eae7e7'
  surface-container-highest: '#e4e2e1'
  on-surface: '#1b1c1c'
  on-surface-variant: '#464742'
  inverse-surface: '#303030'
  inverse-on-surface: '#f3f0f0'
  outline: '#777871'
  outline-variant: '#c7c7bf'
  surface-tint: '#5e5e5b'
  primary: '#5e5e5b'
  on-primary: '#ffffff'
  primary-container: '#f9f7f2'
  on-primary-container: '#71716d'
  inverse-primary: '#c8c6c2'
  secondary: '#5f5e58'
  on-secondary: '#ffffff'
  secondary-container: '#e5e2da'
  on-secondary-container: '#65645e'
  tertiary: '#536254'
  on-tertiary: '#ffffff'
  tertiary-container: '#ebfce9'
  on-tertiary-container: '#667566'
  error: '#ba1a1a'
  on-error: '#ffffff'
  error-container: '#ffdad6'
  on-error-container: '#93000a'
  primary-fixed: '#e4e2dd'
  primary-fixed-dim: '#c8c6c2'
  on-primary-fixed: '#1b1c19'
  on-primary-fixed-variant: '#474744'
  secondary-fixed: '#e5e2da'
  secondary-fixed-dim: '#c9c6bf'
  on-secondary-fixed: '#1c1c17'
  on-secondary-fixed-variant: '#474741'
  tertiary-fixed: '#d6e7d5'
  tertiary-fixed-dim: '#bacbba'
  on-tertiary-fixed: '#111f14'
  on-tertiary-fixed-variant: '#3c4a3d'
  background: '#fcf9f8'
  on-background: '#1b1c1c'
  surface-variant: '#e4e2e1'
typography:
  display:
    fontFamily: Plus Jakarta Sans
    fontSize: 42px
    fontWeight: '500'
    lineHeight: '1.2'
    letterSpacing: -0.02em
  headline-md:
    fontFamily: Plus Jakarta Sans
    fontSize: 24px
    fontWeight: '500'
    lineHeight: '1.4'
    letterSpacing: -0.01em
  headline-sm:
    fontFamily: Plus Jakarta Sans
    fontSize: 20px
    fontWeight: '500'
    lineHeight: '1.4'
  body-lg:
    fontFamily: Plus Jakarta Sans
    fontSize: 18px
    fontWeight: '400'
    lineHeight: '1.8'
  body-md:
    fontFamily: Plus Jakarta Sans
    fontSize: 16px
    fontWeight: '400'
    lineHeight: '1.7'
  label-md:
    fontFamily: Plus Jakarta Sans
    fontSize: 14px
    fontWeight: '500'
    lineHeight: '1.5'
    letterSpacing: 0.02em
  code-md:
    fontFamily: JetBrains Mono
    fontSize: 15px
    fontWeight: '400'
    lineHeight: '1.7'
  display-mobile:
    fontFamily: Plus Jakarta Sans
    fontSize: 32px
    fontWeight: '500'
    lineHeight: '1.2'
rounded:
  sm: 0.25rem
  DEFAULT: 0.5rem
  md: 0.75rem
  lg: 1rem
  xl: 1.5rem
  full: 9999px
spacing:
  unit: 8px
  container-padding: 40px
  gutter: 24px
  section-gap: 64px
  element-gap: 16px
---

## Brand & Style
The design system is built upon the philosophy of "Editorial Zen." It prioritizes the human experience over technical density, transforming the act of coding into a thoughtful, meditative process. The target audience consists of developers and writers who value focus, clarity, and a tactile sense of quality.

The visual style is a blend of **Minimalism** and **Tactile Softness**. It avoids the aggressive efficiency of traditional IDEs in favor of a "Quiet Studio" aesthetic—spacious, warm, and intentional. The interface should feel like a high-end physical notebook or a sunlit architectural studio. Every interaction is designed to be unhurried, using generous whitespace and subtle tonal shifts rather than harsh lines to define structure.

## Colors
The palette is rooted in organic, earthy tones that reduce eye strain and promote a sense of calm.

- **Primary Background (#F9F7F2):** A warm off-white that serves as the "paper" for the interface.
- **Secondary Background (#F1EEE6):** A soft taupe used for sidebars, inset panels, and subtle depth.
- **Primary Text (#2D2D2D):** Deep charcoal-gray. It provides high legibility while appearing softer and more sophisticated than pure black.
- **Accent (#8A9A8A):** A dusty sage green used with extreme restraint. It is reserved for active states, success indicators, and primary actions.
- **Dividers (#E5E1D8):** Very light hairlines intended to disappear into the layout, acting as a whisper of structure rather than a boundary.

## Typography
The typography is relaxed and approachable. By using **Plus Jakarta Sans**, the system gains a friendly, humanist character that balances geometric precision with soft terminals.

- **Body Text:** Set at a generous 18px with a 1.8 line height to ensure reading long-form AI explanations feels effortless.
- **Headings:** Intentionally understated. We avoid heavy weights or all-caps styling to maintain a gentle visual hierarchy.
- **Code:** Utilizing **JetBrains Mono** for its technical excellence, but styled with a custom "Soft Syntax" theme—using muted versions of the brand palette rather than high-contrast neons.
- **Scale:** On mobile devices, display sizes should scale down to 32px to ensure the editorial feel remains intact without overwhelming the viewport.

## Layout & Spacing
The layout follows a **Fluid-Fixed hybrid model**. Content containers have a maximum readable width (e.g., 800px for prose/code) centered within a fluid workspace.

- **The 8px Rhythm:** All spacing is a multiple of 8px, but the "Quiet Studio" aesthetic demands the higher end of the scale. Use 40px or 64px for major section margins to create "breathable" layouts.
- **Horizontal Flow:** Sidebars are non-collapsible by default to maintain stability, using a fixed width of 280px with a subtle `secondary background` fill.
- **Mobile Adaptivity:** On mobile, margins reduce to 24px, and vertical gaps are tightened to 32px. Multi-column structures collapse into a single vertical flow with soft card separations.

## Elevation & Depth
This design system rejects heavy shadows and physical "lift." Instead, depth is communicated through **Tonal Layering** and **Soft Diffusion**.

- **Surface Tiers:** The primary background (#F9F7F2) is the base. Elements that need to "float" (like modals or dropdowns) use a white fill with an extremely soft, large-radius shadow (Blur: 40px, Opacity: 4%, Color: #2D2D2D).
- **Hairlines:** Instead of shadows, use 1px hairlines in `#E5E1D8` to define the edges of UI elements like the code editor or navigation bars.
- **Soft Insets:** Use the secondary background color (#F1EEE6) to create "wells" for content, providing a sense of containment without adding visual weight.

## Shapes
The shape language is organic and inviting. We use a **large corner radius** strategy to eliminate "sharpness" from the digital environment.

- **Large Containers:** Use `rounded-xl` (24px) for the main editor window, chat bubbles, and major cards.
- **Interactive Elements:** Buttons and tags utilize a **full-pill** (rounded-full) radius to emphasize their tactile, "touchable" nature.
- **Nested Elements:** Ensure inner corner radii are calculated (Outer Radius - Padding) to maintain visual harmony.

## Components
- **Buttons:** Primary buttons are pill-shaped with a background of `#2D2D2D` and white text. Secondary buttons use a simple `#E5E1D8` border with no fill. There is no "heavy" hover state—only a subtle opacity shift or a slight darkening of the background.
- **Code Blocks:** Encased in a `rounded-lg` container with the `secondary background`. Syntax highlighting should use the Accent (#8A9A8A) for keywords and muted earth tones for strings/comments.
- **Input Fields:** Large, 18px text, pill-shaped or heavily rounded (12px+). The focus state is a subtle 1px border of the Accent color; avoid "glow" effects.
- **Chips/Tags:** Small pill-shaped elements with a `#F1EEE6` fill and `#2D2D2D` text. Used for file types or status indicators.
- **Chat Bubbles:** AI responses should not have a "bubble" border. Instead, they should be separated by whitespace or a subtle horizontal line to maintain the editorial, document-like flow.