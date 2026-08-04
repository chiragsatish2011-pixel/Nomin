---
name: Bioluminescence Tech
colors:
  surface: '#0b141c'
  surface-dim: '#0b141c'
  surface-bright: '#313a43'
  surface-container-lowest: '#060f17'
  surface-container-low: '#141c25'
  surface-container: '#182029'
  surface-container-high: '#222b34'
  surface-container-highest: '#2d363f'
  on-surface: '#F7F9F8'
  on-surface-variant: '#bacabf'
  inverse-surface: '#dae3ef'
  inverse-on-surface: '#28313a'
  outline: '#85948a'
  outline-variant: '#3b4a42'
  surface-tint: '#23e1a1'
  primary: '#80ffc7'
  on-primary: '#003825'
  primary-container: '#2ee6a6'
  on-primary-container: '#006244'
  inverse-primary: '#006c4b'
  secondary: '#dcb8ff'
  on-secondary: '#480081'
  secondary-container: '#7701d0'
  on-secondary-container: '#dcb7ff'
  tertiary: '#dfe8f4'
  on-tertiary: '#28313a'
  tertiary-container: '#c3ccd8'
  on-tertiary-container: '#4d5660'
  error: '#ffb4ab'
  on-error: '#690005'
  error-container: '#93000a'
  on-error-container: '#ffdad6'
  primary-fixed: '#52febc'
  primary-fixed-dim: '#23e1a1'
  on-primary-fixed: '#002114'
  on-primary-fixed-variant: '#005137'
  secondary-fixed: '#efdbff'
  secondary-fixed-dim: '#dcb8ff'
  on-secondary-fixed: '#2c0051'
  on-secondary-fixed-variant: '#6700b5'
  tertiary-fixed: '#dae3ef'
  tertiary-fixed-dim: '#bec7d3'
  on-tertiary-fixed: '#131c25'
  on-tertiary-fixed-variant: '#3f4851'
  background: '#0b141c'
  on-background: '#dae3ef'
  surface-variant: '#2d363f'
  background-deep: '#071018'
  border-subtle: rgba(255, 255, 255, 0.1)
  surface-glass: rgba(255, 255, 255, 0.04)
  surface-glass-hover: rgba(255, 255, 255, 0.08)
  code-base: rgba(3, 8, 12, 0.6)
typography:
  headline-xl:
    fontFamily: Plus Jakarta Sans
    fontSize: 36px
    fontWeight: '800'
    lineHeight: '1.2'
    letterSpacing: -0.02em
  headline-md:
    fontFamily: Plus Jakarta Sans
    fontSize: 20px
    fontWeight: '700'
    lineHeight: '1.4'
  headline-sm:
    fontFamily: Plus Jakarta Sans
    fontSize: 18px
    fontWeight: '600'
    lineHeight: '1.4'
  body-lg:
    fontFamily: Plus Jakarta Sans
    fontSize: 18px
    fontWeight: '400'
    lineHeight: '1.6'
  body-md:
    fontFamily: Plus Jakarta Sans
    fontSize: 16px
    fontWeight: '400'
    lineHeight: '1.5'
  code-sm:
    fontFamily: JetBrains Mono
    fontSize: 14px
    fontWeight: '400'
    lineHeight: '1.7'
  label-md:
    fontFamily: Plus Jakarta Sans
    fontSize: 14px
    fontWeight: '600'
    lineHeight: '1.2'
  label-xs:
    fontFamily: Plus Jakarta Sans
    fontSize: 12px
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
  xs: 4px
  base: 8px
  sm: 12px
  md: 24px
  lg: 48px
  xl: 80px
  margin-mobile: 16px
  margin-desktop: 64px
  gutter: 24px
---

## Brand & Style

The brand identity, "Trion Agent," is a technical, human-centric AI interface that evokes the feeling of deep-sea bioluminescence. It targets developers and software architects who require a high-focus, high-aesthetic "Technical Workspace."

The design style is a sophisticated blend of **Glassmorphism** and **High-Contrast Dark Mode**. It utilizes translucent layers with heavy backdrop blurs (20px to 40px) to create a sense of oceanic depth. The visual response should be "luminous"—relying on soft emerald glows, prismatic undertones, and interactive "magnetic" elements to make the interface feel alive and reactive.

## Colors

The palette is anchored by "Deep Navy" (#071018) for maximum contrast and "Emerald" (#2EE6A6) as the primary luminescent accent. 

- **Primary:** Emerald green used for active states, primary actions, and "glow" effects.
- **Background:** A deep, near-black navy that serves as the canvas for glass layers.
- **Glass Surfaces:** Semi-transparent whites and navies with varying opacities (4% to 15%) to define depth without solid color blocks.
- **Interactive Accents:** Subtle prismatic shifts into purples and teals are used in background animations and hover states to prevent the dark mode from feeling static.

## Typography

The system uses **Plus Jakarta Sans** for all UI and editorial content to maintain a modern, friendly, yet technical feel. **JetBrains Mono** is reserved strictly for code blocks and system-status indicators ("Planning architecture...").

High-level headlines (XL) utilize an extra-bold weight and negative letter spacing to create a "brutal-modern" impact against the soft glass backgrounds. Text colors primarily use "On-Surface" (Crisp White) for high legibility, with "On-Surface-Variant" (muted sage/grey) for secondary information.

## Layout & Spacing

The layout follows a **responsive shell model**:
- **Desktop:** A fixed-width (256px/64rem) sidebar is docked to the left. The main content is centered within a max-width container of 768px (3xl).
- **Mobile:** The sidebar is hidden in favor of a top-app-bar or hidden drawer. Margins compress from 64px to 16px.

The spacing rhythm is based on an 8px base unit. Wide vertical gaps (80px) are used between distinct chat turns to emphasize individual message blocks as "architectural steps" rather than a dense stream of text.

## Elevation & Depth

Hierarchy is established through **Backdrop Blur** and **Luminous Rims** rather than traditional drop shadows.

1.  **Level 0 (Background):** Deep Navy solid color or animated shader.
2.  **Level 1 (Panels):** `surface-glass` (4% white) with 20px blur and a 1px `border-subtle`.
3.  **Level 2 (Active/Floating):** `deep-glass-panel` (15% white/emerald tint) with 40px blur. 
4.  **The "Luminous Rim":** A 1px internal gradient border that mimics light catching the edge of a glass pane.
5.  **Interactive Glow:** Primary buttons and the input pill use external box-shadows with the primary color at low opacity (e.g., `0 0 20px rgba(46, 230, 166, 0.2)`) to simulate a bioluminescent light source.

## Shapes

The shape language balances utility with organic softness. Standard containers use **Rounded (0.5rem/8px)** corners. Chat bubbles and primary interactive "pills" (like the message input) use high-radius rounding (1.5rem to Full) to appear more inviting and distinct from the structural UI. 

Avatars and specific decorative icons are perfectly circular to contrast with the predominantly rectangular grid.

## Components

- **Buttons:** Primary buttons are pill-shaped, using a semi-transparent background with a luminous border. They must feature a "magnetic" hover effect where they subtly track the cursor.
- **Chat Bubbles:** User bubbles are right-aligned with a sharp corner on the top-right. AI bubbles are left-aligned with a sharp corner on the top-left. Both use "Luminous Rim" borders.
- **Input Field:** A floating pill-shaped "Composer" anchored at the bottom. It features an inner glow and a blurred background to remain legible over scrolling content.
- **Code Blocks:** Encased in a darker, more opaque glass (`code-base`) with a subtle inner shadow and `JetBrains Mono` text.
- **Status Indicators:** Use the `biolum-pulse` animation—a rhythmic opacity and brightness shift—to indicate background processing.
- **Custom Cursor:** A 12px Emerald dot with a trailing 30px ring that reacts (scales and changes border weight) when hovering over interactive elements.