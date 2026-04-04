#!/usr/bin/env node

// patchnet-logo.js
// Prints the PatchnetAI ASCII logo with a blue → orange truecolor gradient.
// Requires a truecolor-capable terminal (Windows Terminal, iTerm2, VS Code, Hyper, etc.)
//
// Usage:
//   node patchnet-logo.js              — print logo + tagline
//   require('./patchnet-logo')         — import printLogo() into your own CLI

const LOGO = [
  "    ____        __       __               __  ",
  "   / __ \\____ _/ /______/ /_  ____  ___  / /_",
  "  / /_/ / __ `/ __/ ___/ __ \\/ __ \\/ _ \\/ __/",
  " / ____/ /_/ / /_/ /__/ / / / / / /  __/ /_  ",
  "/_/    \\__,_/\\__/\\___/_/ /_/_/ /_/\\___/\\__/  ",
]

// Gradient endpoints
const FROM = { r: 91,  g: 137, b: 212 }  // #5b89d4 — blue
const TO   = { r: 240, g: 122, b: 42  }  // #f07a2a — orange

function lerp(a, b, t) {
  return Math.round(a + (b - a) * t)
}

function rgb(r, g, b, text) {
  return `\x1b[38;2;${r};${g};${b}m${text}\x1b[0m`
}

// Check if the terminal supports truecolor
function supportsTruecolor() {
  return (
    process.env.COLORTERM === 'truecolor' ||
    process.env.COLORTERM === '24bit' ||
    (process.env.TERM_PROGRAM === 'iTerm.app') ||
    (process.env.TERM_PROGRAM === 'vscode') ||
    (process.env.WT_SESSION !== undefined) // Windows Terminal
  )
}

function printLogo() {
  const truecolor = supportsTruecolor()

  LOGO.forEach((line, i) => {
    const t = i / Math.max(LOGO.length - 1, 1)

    if (truecolor) {
      const r = lerp(FROM.r, TO.r, t)
      const g = lerp(FROM.g, TO.g, t)
      const b = lerp(FROM.b, TO.b, t)
      console.log(rgb(r, g, b, line))
    } else {
      // Fallback: plain blue for first half, plain orange for second half
      const code = t < 0.5 ? '\x1b[34m' : '\x1b[33m'
      console.log(`${code}${line}\x1b[0m`)
    }
  })
}

function printTagline() {
  const bold   = '\x1b[1m'
  const italic = '\x1b[3m'
  const dim    = '\x1b[2m'
  const reset  = '\x1b[0m'
  const { version } = require('../package.json')
  console.log(`  ${bold}Agent Bridge${reset} ${dim}v${version}${reset}  ${dim}${italic}for OpenClaw and Microsoft Teams${reset}`)
}

function printFooter() {
  const dim    = '\x1b[2m'
  const reset  = '\x1b[0m'
  console.log(`${dim}  Built with \u2764\uFE0F by Patchnet  |  Powered by OpenClaw${reset}`)
  console.log(`${dim}  Not affiliated with or endorsed by Microsoft Corporation.${reset}`)
}

function printDivider(char = '─', width = 48) {
  const dim = '\x1b[2m'
  const reset = '\x1b[0m'
  console.log(`${dim}${char.repeat(width)}${reset}`)
}

// Export for use as a module
module.exports = { printLogo, printTagline, printDivider, printFooter, rgb, lerp }

// Run directly: node patchnet-logo.js
if (require.main === module) {
  console.log()
  printLogo()
  console.log()
  printDivider()
  printTagline()
  printDivider()
  console.log()
}