import { workspaceRoot } from '@nx/devkit';
import * as fs from 'fs';
import { spawn } from 'node-pty';
import * as assert from 'node:assert';
import { test, expect } from '@playwright/test';
import * as path from 'path';
import { PNG } from 'pngjs';
import { Browser, Page, chromium } from '@playwright/test';
import { pathToFileURL } from 'node:url';

// This is a workaround to load ESM modules at runtime
const dynamicImport = new Function('modulePath', 'return import(modulePath);');

interface CustomWindow {
  writeToTerminal: (data: string) => void;
  getTerminalState: () => string;
  resizeTerminal: (cols: number, rows: number) => void;
  fitTerminal: () => { cols: number; rows: number };
}

declare global {
  interface Window extends CustomWindow {}
}

interface DiffResult {
  diffPixels: number;
  percentDiff: string;
  mismatchDetails: string;
}

let pixelmatchModule: any;

/**
 * Compare two images and generate a diff image
 * @param {string} img1Path - Path to the first image (baseline)
 * @param {string} img2Path - Path to the second image (current)
 * @param {string} diffOutputPath - Path to save the diff image
 * @returns {Promise<{diffPixels: number, percentDiff: string, mismatchDetails: string}>} - Difference information
 */
const compareImages = async (
  img1Path: string,
  img2Path: string,
  diffOutputPath: string
): Promise<DiffResult> => {
  // Make sure pixelmatch is loaded
  if (!pixelmatchModule) {
    // pixelmatch is ESM-only
    pixelmatchModule = await dynamicImport('pixelmatch');
  }
  const pixelmatch = pixelmatchModule.default;

  return new Promise((resolve, reject) => {
    // Check if both images exist
    if (!fs.existsSync(img1Path)) {
      console.error(`Baseline image does not exist: ${img1Path}`);
      return resolve({
        diffPixels: 100,
        percentDiff: '100.00',
        mismatchDetails: 'Baseline image missing',
      });
    }

    if (!fs.existsSync(img2Path)) {
      console.error(`Test image does not exist: ${img2Path}`);
      return resolve({
        diffPixels: 100,
        percentDiff: '100.00',
        mismatchDetails: 'Test image missing',
      });
    }

    const img1 = fs
      .createReadStream(img1Path)
      .pipe(new PNG())
      .on('parsed', () => {
        const img2 = fs
          .createReadStream(img2Path)
          .pipe(new PNG())
          .on('parsed', () => {
            const { width, height } = img1;

            // Images must have the same dimensions for pixelmatch
            if (img1.width !== img2.width || img1.height !== img2.height) {
              console.error(
                `Image dimensions don't match: ${img1.width}x${img1.height} vs ${img2.width}x${img2.height}`
              );

              // Create a simple diff image showing the size difference
              const maxWidth = Math.max(img1.width, img2.width);
              const maxHeight = Math.max(img1.height, img2.height);
              const diff = new PNG({ width: maxWidth, height: maxHeight });

              // Fill with a distinctive color to show the difference
              for (let y = 0; y < maxHeight; y++) {
                for (let x = 0; x < maxWidth; x++) {
                  const idx = (y * maxWidth + x) << 2;
                  // @ts-ignore - diff.data is a valid property but TypeScript doesn't recognize it
                  diff.data[idx] = 255; // R - make it red
                  // @ts-ignore - diff.data is a valid property but TypeScript doesn't recognize it
                  diff.data[idx + 1] = 0; // G
                  // @ts-ignore - diff.data is a valid property but TypeScript doesn't recognize it
                  diff.data[idx + 2] = 0; // B
                  // @ts-ignore - diff.data is a valid property but TypeScript doesn't recognize it
                  diff.data[idx + 3] = 255; // A
                }
              }

              // Write diff image
              diff
                .pack()
                .pipe(fs.createWriteStream(diffOutputPath))
                .on('finish', () => {
                  return resolve({
                    diffPixels: width * height,
                    percentDiff: '100.00',
                    mismatchDetails: `Size mismatch: ${img1.width}x${img1.height} vs ${img2.width}x${img2.height}`,
                  });
                });
              return;
            }

            const diff = new PNG({ width, height });

            // Use an extremely low threshold for pixel matching (0.01 instead of 0.05)
            // This makes the comparison extremely strict
            const numDiffPixels = pixelmatch(
              img1.data,
              img2.data,
              diff.data,
              width,
              height,
              {
                threshold: 0.01, // Much lower threshold for extremely sensitive comparison
                alpha: 0.1,
                diffColor: [255, 0, 0], // Bright red for differences
                diffColorAlt: [0, 255, 0], // Bright green for anti-aliased pixels
                diffMask: false, // Draw the diff over a transparent background
                includeAA: true, // Detect anti-aliased pixels
              }
            );

            // Create a side-by-side comparison image
            const comparisonWidth = img1.width * 3; // baseline + current + diff
            const comparisonHeight = img1.height;
            const comparison = new PNG({
              width: comparisonWidth,
              height: comparisonHeight,
            });

            // Fill with black background
            for (
              let i = 0;
              i < comparisonWidth * comparisonHeight * 4;
              i += 4
            ) {
              // @ts-ignore - comparison.data is a valid property but TypeScript doesn't recognize it
              comparison.data[i] = 0; // R
              // @ts-ignore - comparison.data is a valid property but TypeScript doesn't recognize it
              comparison.data[i + 1] = 0; // G
              // @ts-ignore - comparison.data is a valid property but TypeScript doesn't recognize it
              comparison.data[i + 2] = 0; // B
              // @ts-ignore - comparison.data is a valid property but TypeScript doesn't recognize it
              comparison.data[i + 3] = 255; // A
            }

            // Copy baseline image to the left side
            for (let y = 0; y < height; y++) {
              for (let x = 0; x < width; x++) {
                const srcIdx = (y * width + x) << 2;
                const destIdx = (y * comparisonWidth + x) << 2;

                // @ts-ignore - comparison.data is a valid property but TypeScript doesn't recognize it
                comparison.data[destIdx] = img1.data[srcIdx]; // R
                // @ts-ignore - comparison.data is a valid property but TypeScript doesn't recognize it
                comparison.data[destIdx + 1] = img1.data[srcIdx + 1]; // G
                // @ts-ignore - comparison.data is a valid property but TypeScript doesn't recognize it
                comparison.data[destIdx + 2] = img1.data[srcIdx + 2]; // B
                // @ts-ignore - comparison.data is a valid property but TypeScript doesn't recognize it
                comparison.data[destIdx + 3] = img1.data[srcIdx + 3]; // A
              }
            }

            // Copy current image to the middle
            for (let y = 0; y < height; y++) {
              for (let x = 0; x < width; x++) {
                const srcIdx = (y * width + x) << 2;
                const destIdx = (y * comparisonWidth + width + x) << 2;

                // @ts-ignore - comparison.data is a valid property but TypeScript doesn't recognize it
                comparison.data[destIdx] = img2.data[srcIdx]; // R
                // @ts-ignore - comparison.data is a valid property but TypeScript doesn't recognize it
                comparison.data[destIdx + 1] = img2.data[srcIdx + 1]; // G
                // @ts-ignore - comparison.data is a valid property but TypeScript doesn't recognize it
                comparison.data[destIdx + 2] = img2.data[srcIdx + 2]; // B
                // @ts-ignore - comparison.data is a valid property but TypeScript doesn't recognize it
                comparison.data[destIdx + 3] = img2.data[srcIdx + 3]; // A
              }
            }

            // Copy diff image to the right side
            for (let y = 0; y < height; y++) {
              for (let x = 0; x < width; x++) {
                const srcIdx = (y * width + x) << 2;
                const destIdx = (y * comparisonWidth + width * 2 + x) << 2;

                // @ts-ignore - comparison.data is a valid property but TypeScript doesn't recognize it
                comparison.data[destIdx] = diff.data[srcIdx]; // R
                // @ts-ignore - comparison.data is a valid property but TypeScript doesn't recognize it
                comparison.data[destIdx + 1] = diff.data[srcIdx + 1]; // G
                // @ts-ignore - comparison.data is a valid property but TypeScript doesn't recognize it
                comparison.data[destIdx + 2] = diff.data[srcIdx + 2]; // B
                // @ts-ignore - comparison.data is a valid property but TypeScript doesn't recognize it
                comparison.data[destIdx + 3] = diff.data[srcIdx + 3]; // A
              }
            }

            // Add labels to the comparison image
            drawText(comparison, 10, 10, 'Baseline', [255, 255, 0]); // Yellow
            drawText(comparison, img1.width + 10, 10, 'Current', [0, 255, 255]); // Cyan
            drawText(
              comparison,
              img1.width * 2 + 10,
              10,
              'Diff',
              [255, 0, 255]
            ); // Magenta

            // Calculate percentage difference
            const percentDiff = (numDiffPixels / (width * height)) * 100;
            const percentDiffStr = percentDiff.toFixed(2);

            // Add percentage difference to the image
            drawText(
              comparison,
              img1.width * 2 + 10,
              25,
              `${percentDiffStr}% diff`,
              [255, 0, 255]
            ); // Magenta

            // Generate detailed mismatch information
            let mismatchDetails = `${numDiffPixels} pixels differ (${percentDiffStr}% of total)`;

            // Write the side-by-side comparison image
            comparison
              .pack()
              .pipe(fs.createWriteStream(diffOutputPath))
              .on('finish', () => {
                resolve({
                  diffPixels: numDiffPixels,
                  percentDiff: percentDiffStr,
                  mismatchDetails,
                });
              })
              .on('error', (err) => {
                console.error('Error writing comparison image:', err);
                reject(err);
              });
          })
          .on('error', (err) => {
            console.error('Error parsing img2:', err);
            reject(err);
          });
      })
      .on('error', (err) => {
        console.error('Error parsing img1:', err);
        reject(err);
      });
  });
};

/**
 * Verify a screenshot against a baseline image
 * @param {string} screenshotPath - Path to the screenshot to verify
 * @param {string} baselineName - Name of the baseline to compare against
 * @param {number} threshold - Threshold percentage for acceptable difference
 * @param {boolean} keepDiffs - Whether to keep diff images even when comparison passes
 * @returns {Promise<boolean>} - Whether the verification passed
 */
const verifyAgainstBaseline = async (
  screenshotPath: string,
  baselineName: string,
  threshold = 0.1,
  keepDiffs = true
): Promise<boolean> => {
  // Lower default threshold from 1% to 0.1% for extremely sensitive comparison

  const baselineDir = path.join(__dirname, 'baselines');
  const baselinePath = path.join(baselineDir, `${baselineName}.png`);
  const diffDir = path.join(__dirname, 'diffs');
  const diffPath = path.join(diffDir, `diff-${baselineName}-${Date.now()}.png`);

  // Create baseline directory if it doesn't exist
  if (!fs.existsSync(baselineDir)) {
    fs.mkdirSync(baselineDir, { recursive: true });
  }

  // Create diffs directory if it doesn't exist
  if (!fs.existsSync(diffDir)) {
    fs.mkdirSync(diffDir, { recursive: true });
  }

  // If baseline doesn't exist, save this screenshot as baseline
  if (!fs.existsSync(baselinePath)) {
    console.log(
      `Baseline image doesn't exist. Saving ${screenshotPath} as baseline for ${baselineName}`
    );
    fs.copyFileSync(screenshotPath, baselinePath);
    return true;
  }

  // Compare the images
  const diffResult = await compareImages(
    baselinePath,
    screenshotPath,
    diffPath
  );

  // Check if difference is within acceptable threshold
  const diffPercentage = parseFloat(diffResult.percentDiff);
  const passed = diffPercentage <= threshold;

  if (passed) {
    console.log(
      `✅ Screenshot matches baseline for ${baselineName} (${diffResult.percentDiff}% difference)`
    );

    // Only remove diff file if keepDiffs is false
    if (!keepDiffs) {
      try {
        fs.unlinkSync(diffPath);
      } catch (error) {
        console.warn(
          `Warning: Could not delete diff file ${diffPath}:`,
          error.message
        );
      }
    } else {
      console.log(
        `Diff image saved to: ${diffPath} (passed but kept for reference)`
      );
    }
  } else {
    console.log(
      `❌ Screenshot differs from baseline for ${baselineName} (${diffResult.percentDiff}% difference)`
    );
    console.log(`Details: ${diffResult.mismatchDetails}`);
    console.log(`Diff image saved to: ${diffPath}`);
  }

  return passed;
};

// Create a simple HTML file with xterm.js for rendering the terminal
const createHtmlFile = (): string => {
  const htmlPath = path.join(__dirname, 'terminal-renderer.html');

  // Use absolute paths for node_modules dependencies
  const nodeModulesPath = path.join(workspaceRoot, 'node_modules');

  // Verify that required files exist
  const requiredFiles = [
    path.join(nodeModulesPath, 'xterm/css/xterm.css'),
    path.join(nodeModulesPath, 'xterm/lib/xterm.js'),
    path.join(nodeModulesPath, 'xterm-addon-fit/lib/xterm-addon-fit.js'),
    path.join(
      nodeModulesPath,
      'xterm-addon-serialize/lib/xterm-addon-serialize.js'
    ),
  ];

  for (const file of requiredFiles) {
    if (!fs.existsSync(file)) {
      throw new Error(`Required file not found: ${file}`);
    }
  }

  const html = `
<!DOCTYPE html>
<html>
<head>
  <link rel="stylesheet" href="file://${path.join(
    nodeModulesPath,
    'xterm/css/xterm.css'
  )}" />
  <script src="file://${path.join(
    nodeModulesPath,
    'xterm/lib/xterm.js'
  )}"></script>
  <script src="file://${path.join(
    nodeModulesPath,
    'xterm-addon-fit/lib/xterm-addon-fit.js'
  )}"></script>
  <script src="file://${path.join(
    nodeModulesPath,
    'xterm-addon-serialize/lib/xterm-addon-serialize.js'
  )}"></script>
  <style>
    html, body {
      margin: 0;
      padding: 0;
      height: 100%;
      width: 100%;
      background: #000;
      overflow: hidden;
    }
    #terminal {
      width: 100%;
      height: 100%;
      position: absolute;
      top: 0;
      left: 0;
      right: 0;
      bottom: 0;
    }
    .xterm-viewport {
      overflow-y: hidden !important;
    }
  </style>
</head>
<body>
  <div id="terminal"></div>
  <script>
    const term = new Terminal({
      fontFamily: 'Menlo, Monaco, "Courier New", monospace',
      fontSize: 14,
      lineHeight: 1.2,
      cursorBlink: false,
      allowTransparency: true,
      theme: {
        background: '#000000',
        foreground: '#ffffff'
      },
      scrollback: 0,
      disableStdin: true
    });

    term.open(document.getElementById('terminal'));

    const fitAddon = new FitAddon.FitAddon();
    term.loadAddon(fitAddon);

    const serializeAddon = new SerializeAddon.SerializeAddon();
    term.loadAddon(serializeAddon);

    // Expose methods for puppeteer to call
    window.writeToTerminal = (data) => {
      term.write(data);
    };

    window.getTerminalState = () => {
      return serializeAddon.serialize();
    };

    window.resizeTerminal = (cols, rows) => {
      term.resize(cols, rows);
      fitAddon.fit();
    };

    window.fitTerminal = () => {
      fitAddon.fit();
      return { cols: term.cols, rows: term.rows };
    };

    // Initial fit
    setTimeout(() => {
      fitAddon.fit();
      console.log('Terminal fitted to', term.cols, 'x', term.rows);
    }, 100);

    // Handle window resize
    window.addEventListener('resize', () => {
      fitAddon.fit();
    });
  </script>
</body>
</html>
  `;

  fs.writeFileSync(htmlPath, html);
  return htmlPath;
};

/**
 * Send keyboard input to the terminal process
 * @param {any} pty - The pty process
 * @param {string} input - The input to send
 * @returns {Promise<void>}
 */
const sendInput = async (pty: any, input: string): Promise<void> => {
  return new Promise((resolve) => {
    console.log(`Sending input: ${JSON.stringify(input)}`);
    pty.write(input);
    // Give some time for the terminal to process the input
    setTimeout(resolve, 500);
  });
};

// Define the browser context function type
type BrowserFunction<T = void> = (
  this: Window & typeof globalThis & CustomWindow,
  ...args: any[]
) => T;

const waitForText = async (
  page: Page,
  text: string | RegExp,
  timeout = 10000,
  pollInterval = 100
): Promise<boolean> => {
  console.log(
    `Waiting for text: ${
      text instanceof RegExp ? text.toString() : `"${text}"`
    }`
  );

  try {
    const checkText: BrowserFunction = function ({ searchText, isRegex }) {
      const content = this.getTerminalState();
      if (!isRegex) {
        return content.includes(searchText);
      } else {
        const regexParts = /\/(.*)\/([gimuy]*)/.exec(searchText);
        if (regexParts) {
          const [, pattern, flags] = regexParts;
          const regex = new RegExp(pattern, flags);
          return regex.test(content);
        }
        return false;
      }
    };

    await page.waitForFunction(
      checkText,
      {
        searchText: text instanceof RegExp ? text.toString() : text,
        isRegex: text instanceof RegExp,
      },
      { timeout, polling: pollInterval }
    );

    console.log(`✅ Found text after ${timeout}ms`);
    return true;
  } catch (error) {
    // Capture a failure screenshot for debugging
    const failureScreenshotPath = path.join(
      __dirname,
      `failure-waiting-for-text-${Date.now()}.png`
    );
    await page.screenshot({ path: failureScreenshotPath });
    console.log(`📸 Failure screenshot saved to: ${failureScreenshotPath}`);

    // Get the current terminal content for debugging
    const getTerminalState: BrowserFunction<string> = function () {
      return this.getTerminalState();
    };
    const terminalContent = await page.evaluate(getTerminalState);
    const contentPreview =
      terminalContent.length > 500
        ? terminalContent.substring(0, 500) + '...'
        : terminalContent;
    console.log(`📄 Terminal content at failure:\n${contentPreview}`);

    const errorMessage = `Timeout waiting for text: ${
      text instanceof RegExp ? text.toString() : `"${text}"`
    } after ${timeout}ms`;
    console.error(`❌ ${errorMessage}`);
    throw new Error(
      `${errorMessage} (see screenshot at ${failureScreenshotPath})`
    );
  }
};

/**
 * Wait for a condition to be true in the terminal
 * @param {string} description - Description of what condition we're waiting for
 * @param {any} page - Puppeteer page
 * @param {Function} conditionFn - Function that evaluates in browser context and returns boolean
 * @param {number} timeout - Maximum time to wait in milliseconds
 * @param {number} pollInterval - How often to check the condition in milliseconds
 * @returns {Promise<boolean>} - Resolves to true when condition is met, or false if timeout
 */
const waitForCondition = async (
  description: string,
  page: Page,
  conditionFn: BrowserFunction<boolean>,
  timeout = 10000,
  pollInterval = 100
): Promise<boolean> => {
  console.log(`Waiting for: ${description}`);

  try {
    await page.waitForFunction(conditionFn, { timeout, polling: pollInterval });
    console.log(`✅ Condition met: ${description}`);
    return true;
  } catch (error) {
    // Capture a failure screenshot for debugging
    const failureScreenshotPath = path.join(
      __dirname,
      `failure-${description
        .replace(/[^a-z0-9]/gi, '-')
        .toLowerCase()}-${Date.now()}.png`
    );
    await page.screenshot({ path: failureScreenshotPath });
    console.log(`📸 Failure screenshot saved to: ${failureScreenshotPath}`);

    // Get the current terminal content for debugging
    const getTerminalState: BrowserFunction<string> = function () {
      return this.getTerminalState();
    };
    const terminalContent = await page.evaluate(getTerminalState);
    const contentPreview =
      terminalContent.length > 500
        ? terminalContent.substring(0, 500) + '...'
        : terminalContent;
    console.log(`📄 Terminal content at failure:\n${contentPreview}`);

    const errorMessage = `Timeout waiting for condition: ${description} after ${timeout}ms`;
    console.error(`❌ ${errorMessage}`);
    throw new Error(
      `${errorMessage} (see screenshot at ${failureScreenshotPath})`
    );
  }
};

/**
 * Capture a screenshot and wait for the page to stabilize first
 * @param {any} page - Puppeteer page
 * @param {string} name - Name for the screenshot
 * @param {number} stabilityTimeout - How long to wait for stability in milliseconds
 * @param {number} stabilityThreshold - How many consecutive stable checks needed
 * @returns {Promise<string>} - Path to the saved screenshot
 */
const captureStableScreenshot = async (
  page: Page,
  name: string,
  stabilityTimeout = 5000,
  stabilityThreshold = 5
): Promise<string> => {
  console.log(`Capturing stable screenshot: ${name}`);

  // Wait for visual stability by comparing terminal content
  const startTime = Date.now();
  let stableCount = 0;
  let lastContent = '';

  while (
    stableCount < stabilityThreshold &&
    Date.now() - startTime < stabilityTimeout
  ) {
    // Get current terminal content
    const getTerminalState: BrowserFunction<string> = function () {
      return this.getTerminalState();
    };
    const currentContent = await page.evaluate(getTerminalState);

    if (currentContent === lastContent) {
      stableCount++;
    } else {
      stableCount = 0;
      lastContent = currentContent;
    }

    await page.waitForTimeout(100);
  }

  if (stableCount >= stabilityThreshold) {
    console.log(
      `✅ Terminal content stabilized after ${Date.now() - startTime}ms`
    );
  } else {
    console.log(
      `⚠️ Terminal content did not fully stabilize after ${stabilityTimeout}ms`
    );
  }

  // Take the screenshot
  const screenshotPath = path.join(
    __dirname,
    `terminal-${name}-${Date.now()}.png`
  );
  await page.screenshot({ path: screenshotPath });
  console.log(`Screenshot saved to ${screenshotPath}`);

  return screenshotPath;
};

interface NavigationScreenshots {
  beforeNavPath: string;
  afterNav1Path: string;
  afterNav2Path: string;
  afterSelectPath: string;
}

/**
 * Navigate through the TUI using keyboard inputs and wait for specific content
 * @param {any} pty - The pty process
 * @param {any} page - The puppeteer page
 * @returns {Promise<{beforeNavPath: string, afterNav1Path: string, afterNav2Path: string, afterSelectPath: string}>}
 */
const navigateTUI = async (
  pty: any,
  page: Page
): Promise<NavigationScreenshots> => {
  // Wait for the TUI to fully render - look for the task list header
  await waitForText(page, 'run-many', 15000);

  // Take a screenshot before navigation
  const beforeNavPath = await captureStableScreenshot(page, 'before-nav');

  // Navigate down (arrow down key)
  await sendInput(pty, '\x1B[B'); // ESC [ B is the escape sequence for down arrow

  // Wait for the selection indicator to move
  // await waitForCondition(
  //   "selection indicator to move to the second line",
  //   page,
  //   function() {
  //     const content = this.getTerminalState();
  //     const lines = content.split('\n');
  //     return lines.length > 1 && (lines[1].includes('>') || lines[1].includes('❯'));
  //   }
  // );

  // Take a screenshot after first navigation
  const afterNav1Path = await captureStableScreenshot(page, 'after-nav1');

  // Navigate down again
  await sendInput(pty, '\x1B[B');

  // Wait for the selection indicator to move to the third line
  // await waitForCondition(
  //   "selection indicator to move to the third line",
  //   page,
  //   function() {
  //     const content = this.getTerminalState();
  //     const lines = content.split('\n');
  //     return lines.length > 2 && (lines[2].includes('>') || lines[2].includes('❯'));
  //   }
  // );

  // Take a screenshot after second navigation
  const afterNav2Path = await captureStableScreenshot(page, 'after-nav2');

  // Press spacebar to select the item
  await sendInput(pty, ' ');

  // Wait for the selection screen to disappear and build to start
  // await waitForText(page, "Building", 10000);

  // Take a screenshot after selection
  const afterSelectPath = await captureStableScreenshot(page, 'after-select');

  return {
    beforeNavPath,
    afterNav1Path,
    afterNav2Path,
    afterSelectPath,
  };
};

/**
 * Draw simple text on an image
 * @param {any} png - The PNG image
 * @param {number} x - X coordinate
 * @param {number} y - Y coordinate
 * @param {string} text - Text to draw
 * @param {number[]} color - RGB color array [r, g, b]
 */
const drawText = (
  png: PNG,
  x: number,
  y: number,
  text: string,
  color: [number, number, number] = [255, 255, 255]
): void => {
  const width = png.width;

  // Simple 5x7 pixel font for basic characters
  const font = {
    B: [
      [1, 1, 1, 0, 0],
      [1, 0, 0, 1, 0],
      [1, 0, 0, 1, 0],
      [1, 1, 1, 0, 0],
      [1, 0, 0, 1, 0],
      [1, 0, 0, 1, 0],
      [1, 1, 1, 0, 0],
    ],
    a: [
      [0, 0, 0, 0, 0],
      [0, 0, 0, 0, 0],
      [0, 1, 1, 0, 0],
      [0, 0, 0, 1, 0],
      [0, 1, 1, 1, 0],
      [1, 0, 0, 1, 0],
      [0, 1, 1, 1, 0],
    ],
    s: [
      [0, 0, 0, 0, 0],
      [0, 0, 0, 0, 0],
      [0, 1, 1, 1, 0],
      [1, 0, 0, 0, 0],
      [0, 1, 1, 0, 0],
      [0, 0, 0, 1, 0],
      [1, 1, 1, 0, 0],
    ],
    e: [
      [0, 0, 0, 0, 0],
      [0, 0, 0, 0, 0],
      [0, 1, 1, 0, 0],
      [1, 0, 0, 1, 0],
      [1, 1, 1, 1, 0],
      [1, 0, 0, 0, 0],
      [0, 1, 1, 1, 0],
    ],
    l: [
      [0, 1, 1, 0, 0],
      [0, 0, 1, 0, 0],
      [0, 0, 1, 0, 0],
      [0, 0, 1, 0, 0],
      [0, 0, 1, 0, 0],
      [0, 0, 1, 0, 0],
      [0, 1, 1, 1, 0],
    ],
    i: [
      [0, 0, 0, 0, 0],
      [0, 0, 1, 0, 0],
      [0, 0, 0, 0, 0],
      [0, 0, 1, 0, 0],
      [0, 0, 1, 0, 0],
      [0, 0, 1, 0, 0],
      [0, 0, 1, 0, 0],
    ],
    n: [
      [0, 0, 0, 0, 0],
      [0, 0, 0, 0, 0],
      [1, 0, 1, 0, 0],
      [1, 1, 0, 1, 0],
      [1, 0, 0, 1, 0],
      [1, 0, 0, 1, 0],
      [1, 0, 0, 1, 0],
    ],
    C: [
      [0, 1, 1, 1, 0],
      [1, 0, 0, 0, 0],
      [1, 0, 0, 0, 0],
      [1, 0, 0, 0, 0],
      [1, 0, 0, 0, 0],
      [1, 0, 0, 0, 0],
      [0, 1, 1, 1, 0],
    ],
    u: [
      [0, 0, 0, 0, 0],
      [0, 0, 0, 0, 0],
      [1, 0, 0, 1, 0],
      [1, 0, 0, 1, 0],
      [1, 0, 0, 1, 0],
      [1, 0, 0, 1, 0],
      [0, 1, 1, 1, 0],
    ],
    r: [
      [0, 0, 0, 0, 0],
      [0, 0, 0, 0, 0],
      [1, 0, 1, 1, 0],
      [1, 1, 0, 0, 0],
      [1, 0, 0, 0, 0],
      [1, 0, 0, 0, 0],
      [1, 0, 0, 0, 0],
    ],
    t: [
      [0, 0, 1, 0, 0],
      [0, 0, 1, 0, 0],
      [0, 1, 1, 1, 0],
      [0, 0, 1, 0, 0],
      [0, 0, 1, 0, 0],
      [0, 0, 1, 0, 0],
      [0, 0, 0, 1, 0],
    ],
    D: [
      [1, 1, 1, 0, 0],
      [1, 0, 0, 1, 0],
      [1, 0, 0, 1, 0],
      [1, 0, 0, 1, 0],
      [1, 0, 0, 1, 0],
      [1, 0, 0, 1, 0],
      [1, 1, 1, 0, 0],
    ],
    f: [
      [0, 0, 1, 1, 0],
      [0, 1, 0, 0, 0],
      [1, 1, 1, 0, 0],
      [0, 1, 0, 0, 0],
      [0, 1, 0, 0, 0],
      [0, 1, 0, 0, 0],
      [0, 1, 0, 0, 0],
    ],
    ' ': [
      [0, 0, 0, 0, 0],
      [0, 0, 0, 0, 0],
      [0, 0, 0, 0, 0],
      [0, 0, 0, 0, 0],
      [0, 0, 0, 0, 0],
      [0, 0, 0, 0, 0],
      [0, 0, 0, 0, 0],
    ],
    ':': [
      [0, 0, 0, 0, 0],
      [0, 0, 0, 0, 0],
      [0, 0, 1, 0, 0],
      [0, 0, 0, 0, 0],
      [0, 0, 0, 0, 0],
      [0, 0, 1, 0, 0],
      [0, 0, 0, 0, 0],
    ],
  };

  let currentX = x;

  // Draw each character
  for (let i = 0; i < text.length; i++) {
    const char = text[i];
    const charPattern = font[char] || font[' ']; // Default to space if character not found

    for (let row = 0; row < charPattern.length; row++) {
      for (let col = 0; col < charPattern[0].length; col++) {
        if (charPattern[row][col]) {
          const pixelX = currentX + col;
          const pixelY = y + row;
          const idx = (pixelY * width + pixelX) << 2;

          // @ts-ignore - png.data is a valid property but TypeScript doesn't recognize it
          png.data[idx] = color[0]; // R
          // @ts-ignore - png.data is a valid property but TypeScript doesn't recognize it
          png.data[idx + 1] = color[1]; // G
          // @ts-ignore - png.data is a valid property but TypeScript doesn't recognize it
          png.data[idx + 2] = color[2]; // B
          // @ts-ignore - png.data is a valid property but TypeScript doesn't recognize it
          png.data[idx + 3] = 255; // A
        }
      }
    }

    currentX += 6; // Character width + 1 pixel spacing
  }
};

test('Nx TUI renders correctly and responds to navigation', async ({ page }) => {
  // Create HTML file for rendering
  const htmlPath = createHtmlFile();

  // Use the page fixture provided by Playwright
  await page.goto(`file://${htmlPath}`);

  // Wait for the page to load and terminal to initialize
  const checkFitTerminal: BrowserFunction<boolean> = function () {
    return !!this.fitTerminal?.();
  };
  await page.waitForFunction(checkFitTerminal);

  // Fit terminal to viewport and get dimensions
  const getFitDimensions: BrowserFunction<{ cols: number; rows: number }> =
    function () {
      return this.fitTerminal();
    };
  const dimensions = await page.evaluate(getFitDimensions);

  console.log(`Terminal dimensions: ${dimensions.cols}x${dimensions.rows}`);

  // Step 1: Spawn Nx CLI using node-pty
  console.log('Spawning Nx TUI...');
  const pty = spawn(
    'pnpm',
    ['nx', 'run-many', '--target=lint', '--projects="nx-*"'],
    {
      name: 'xterm-color',
      cols: dimensions.cols || 80,
      rows: dimensions.rows || 24,
      cwd: process.cwd(),
      env: {
        ...process.env,
        NX_TUI: 'true',
        FORCE_COLOR: '3', // Force color output
      },
    }
  );

  let fullOutput = '';
  const outputChunks: string[] = [];

  // Create a promise to capture terminal state after a delay
  const captureTerminalState = async (delay = 1000) => {
    await page.waitForTimeout(delay);

    // Get terminal state
    const getTerminalState: BrowserFunction<string> = function () {
      return this.getTerminalState();
    };
    const serializedState = await page.evaluate(getTerminalState);

    // Take a screenshot
    const screenshotPath = path.join(
      __dirname,
      `terminal-state-${Date.now()}.png`
    );
    await page.screenshot({ path: screenshotPath });

    console.log(`Terminal state captured and saved to ${screenshotPath}`);
    return { serializedState, screenshotPath };
  };

  // Process data from pty and send to browser
  pty.onData(async (data) => {
    fullOutput += data;
    outputChunks.push(data);

    // Send data to browser for rendering
    const writeToTerminal: BrowserFunction = function (text: string) {
      this.writeToTerminal(text);
    };
    await page.evaluate(writeToTerminal, data);
  });

  try {
    // Wait for initial render - look for the Nx logo or header
    await waitForText(page, 'NX', 15000);

    // Capture initial state
    const initialState = {
      screenshotPath: await captureStableScreenshot(page, 'initial-state'),
    };

    // Navigate through the TUI
    const navigationScreenshots = await navigateTUI(pty, page);

    // Wait for the build to complete or reach a specific state
    await waitForText(page, 'Completed', 30000);

    // Capture final state
    const finalState = {
      screenshotPath: await captureStableScreenshot(page, 'final-state'),
    };

    // Clean up
    pty.kill();

    // Save the full output for debugging
    fs.writeFileSync(path.join(__dirname, 'terminal-output.txt'), fullOutput);
    fs.writeFileSync(
      path.join(__dirname, 'terminal-chunks.json'),
      JSON.stringify(outputChunks, null, 2)
    );

    console.log('Test completed successfully');
    console.log(`Initial screenshot: ${initialState.screenshotPath}`);
    console.log(`Navigation screenshots:`, navigationScreenshots);
    console.log(`Final screenshot: ${finalState.screenshotPath}`);

    // Verify screenshots against baselines
    console.log('\n--- Comparing screenshots against baselines ---\n');
    const initialResult = await verifyAgainstBaseline(
      initialState.screenshotPath,
      'initial-state',
      0.1, // 0.1% threshold
      true // Keep diff images
    );

    const beforeNavResult = await verifyAgainstBaseline(
      navigationScreenshots.beforeNavPath,
      'before-navigation',
      0.1,
      true
    );

    const afterNav1Result = await verifyAgainstBaseline(
      navigationScreenshots.afterNav1Path,
      'after-navigation-1',
      0.1,
      true
    );

    const afterNav2Result = await verifyAgainstBaseline(
      navigationScreenshots.afterNav2Path,
      'after-navigation-2',
      0.1,
      true
    );

    const afterSelectResult = await verifyAgainstBaseline(
      navigationScreenshots.afterSelectPath,
      'after-selection',
      0.1,
      true
    );

    const finalResult = await verifyAgainstBaseline(
      finalState.screenshotPath,
      'final-state',
      0.1,
      true
    );

    console.log(
      '\n--- All diff images are saved in the "diffs" directory ---\n'
    );

    // Use Playwright's expect instead of node:assert
    expect(initialResult).toBeTruthy();
    expect(beforeNavResult).toBeTruthy();
    expect(afterNav1Result).toBeTruthy();
    expect(afterNav2Result).toBeTruthy();
    expect(afterSelectResult).toBeTruthy();
    expect(finalResult).toBeTruthy();
  } catch (error) {
    pty.kill();
    throw error;
  }
});
