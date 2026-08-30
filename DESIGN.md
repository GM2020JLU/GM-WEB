# Gou Min Personal Site Design System

## 1. Atmosphere & Identity

The site is a calm engineering notebook: precise enough to feel trustworthy, warm enough to feel personal. Its signature is the combination of paper-like horizontal rules, restrained blue ink, and small monospace annotations that make the interface feel like a well-kept lab notebook rather than a product landing page.

## 2. Color

The active `blue-soft` palette and the shared tokens from `@navfolio/theme-default` are the source of truth. Components use semantic tokens only.

| Role       | Token                                                  | Usage                        |
| ---------- | ------------------------------------------------------ | ---------------------------- |
| Page       | `--paper-bg`, `--paper-page-bg`                        | Document background          |
| Surface    | `--paper-surface`, `--paper-surface-muted`             | Cards and inset areas        |
| Text       | `--paper-ink`, `--paper-ink-soft`, `--paper-ink-faint` | Primary, secondary, metadata |
| Accent     | `--paper-accent`, `--paper-accent-soft`                | Links, focus, current state  |
| Rule       | `--paper-line`, `--paper-line-strong`                  | Dividers and boundaries      |
| Control    | `--paper-control`, `--paper-control-hover`             | Interactive backgrounds      |
| Navigation | `--paper-nav`                                          | Floating navigation          |

Accent color communicates identity and interaction. It is not used as decorative fill outside small marks and controls.

## 3. Typography

| Level      | Size                        | Weight | Line height | Usage                 |
| ---------- | --------------------------- | ------ | ----------- | --------------------- |
| Display    | `clamp(2.25rem, 5vw, 4rem)` | 400    | 1.08        | Home identity         |
| H1         | `clamp(2rem, 4vw, 3.35rem)` | 400    | 1.08        | Page title            |
| H2         | `1.25rem`                   | 600    | 1.35        | Section title         |
| H3         | `1rem`                      | 600    | 1.45        | Card title            |
| Body large | `1.05rem`                   | 400    | 1.9         | Introductory copy     |
| Body       | `1rem`                      | 400    | 1.8         | Reading text          |
| Small      | `0.82rem`                   | 500    | 1.5         | Secondary information |
| Label      | `0.72rem`                   | 600    | 1.4         | Monospace annotations |

- Page headings: `--font-page-heading`.
- Body and Chinese reading: `--font-body` / `--font-serif-cn`.
- Labels, dates, and technical annotations: `--font-ui-label`.
- Display lines balance; reading lines remain below roughly 66 Chinese characters.

## 4. Spacing & Layout

Spacing follows a 4px base: 4, 8, 12, 16, 20, 24, 32, 40, 48, 64, 80, and 96px. The public shell uses `--layout-shell-width`, `--layout-page-gutter`, and `--layout-page-bottom` from the theme.

- Desktop home: asymmetric content/sidebar grid; the introduction is dominant.
- Tablet: one readable column.
- Mobile: identity and introduction appear before navigation and activity data.
- The fixed top navigation must never cover the first interactive element.

## 5. Components

### Floating navigation

- **Structure**: brand, primary routes, icon actions, mobile disclosure.
- **States**: active route, hover, focus, pending navigation, open mobile menu.
- **Accessibility**: semantic navigation, labelled icon buttons, Escape closes disclosures.
- **Motion**: opacity and vertical transform only; hidden while scrolling down and restored on intent.

### Identity panel

- **Structure**: framed portrait, name, handle, role, contact actions.
- **States**: contact hover/focus/copied.
- **Accessibility**: meaningful portrait alternative, labelled links and copy button.
- **Layout**: sidebar stack on desktop; compact centered block on mobile.

### Intro action group

- **Structure**: technical label, display identity, short manifesto, focus tags, primary/secondary actions.
- **States**: default, hover, active, focus-visible.
- **Accessibility**: semantic heading and navigation label; visible focus ring.
- **Layout**: left-aligned stack with a readable text measure.

### Editorial list link

- **Structure**: icon or marker, title, optional metadata, directional affordance.
- **States**: default, hover, active, focus-visible.
- **Accessibility**: complete linked row with no nested controls.
- **Motion**: color and transform only.

## 6. Motion & Interaction

| Type     | Duration | Easing   | Usage                   |
| -------- | -------- | -------- | ----------------------- |
| Press    | 120ms    | ease-out | Button/link press       |
| Micro    | 180ms    | ease     | Hover and icon feedback |
| Standard | 220ms    | ease     | Navigation visibility   |
| Entry    | 420ms    | ease-out | Existing card entry     |

All interactive elements expose hover, active, and focus-visible feedback. Motion uses transform and opacity, and non-essential effects stop under `prefers-reduced-motion`.

## 7. Depth & Surface

Strategy: mixed, but restrained. Most content is separated by whitespace and rules. Only navigation, identity, popovers, and genuinely grouped information receive a paper surface using `--paper-shadow` or `--paper-shadow-lift`. Nested cards are not used.

## 8. Accessibility Constraints & Accepted Debt

### Constraints

- Target WCAG 2.2 AA with visible keyboard focus and complete keyboard reachability.
- Body text remains at least 14px; touch targets are at least 40px where space permits.
- Primary content must reflow without horizontal scrolling at 375px.
- Theme, navigation, and clipboard interactions retain explicit accessible names and status feedback.

### Accepted Debt

| Item                                                | Location                  | Why accepted                                                                     | Owner / Exit                                        |
| --------------------------------------------------- | ------------------------- | -------------------------------------------------------------------------------- | --------------------------------------------------- |
| Theme token definitions live in a GitHub dependency | `@navfolio/theme-default` | This repository is the composition root and must not duplicate package ownership | Move changes upstream when palette semantics change |
