import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const indexHtml = fs.readFileSync('index.html', 'utf8');
const pluginJs = fs.readFileSync('static/js/planarvibe-plugin.js', 'utf8');
const appCss = fs.readFileSync('static/css/app.css', 'utf8');

const agenticLayouts = [
  {
    key: 'gpt',
	    script: 'static/js/layout-gpt.js',
	    module: 'PlanarVibeGPT',
	    method: 'applyLayout'
	  },
  {
    key: 'claude',
	    script: 'static/js/layout-claude.js',
	    module: 'PlanarVibeClaude',
	    method: 'applyLayout'
  }
];

test('GPT and Claude layouts are wired from UI through the layout config table', () => {
  for (const layout of agenticLayouts) {
    assert.match(
      indexHtml,
      new RegExp(`data-layout="${layout.key}"`),
      `${layout.key} should have a toolbar button`
    );
    assert.match(
      indexHtml,
      new RegExp(`<script src="${layout.script.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}"></script>`),
      `${layout.key} script should be loaded by index.html`
    );
    assert.match(
      pluginJs,
      new RegExp(`${layout.key}: \\{[\\s\\S]*?getModule: function \\(\\) \\{ return global\\.${layout.module}; \\}[\\s\\S]*?methodName: '${layout.method}'`),
      `${layout.key} should have an applyLayout dispatcher entry`
    );
  }
});

test('Drawing Stats shows Mean Score immediately after Plane', () => {
  const planeIndex = indexHtml.indexOf('id="stat-is-plane"');
  const overallIndex = indexHtml.indexOf('id="stats-overall-score"');
  const angularIndex = indexHtml.indexOf('id="stats-angle-quality"');

  assert.notEqual(planeIndex, -1, 'Plane stat should exist');
  assert.notEqual(overallIndex, -1, 'Mean Score stat should exist');
  assert.notEqual(angularIndex, -1, 'Angular Resolution stat should exist');
  assert.ok(planeIndex < overallIndex, 'Mean Score should appear after Plane');
  assert.ok(overallIndex < angularIndex, 'Mean Score should appear before the metric rows');
  assert.match(pluginJs, /function updateOverallScore\(/, 'plugin should compute the Mean Score');
});

test('FABalancer replaces the former staged balancer wiring', () => {
  const oldKey = 'hy' + 'brid';
  const oldScript = 'layout-' + oldKey + 'balancer\\.js';
  assert.match(indexHtml, /data-layout="fabalancer"/, 'FABalancer should have a toolbar button');
  assert.match(indexHtml, /static\/js\/layout-fabalancer\.js/, 'FABalancer script should be loaded');
  assert.doesNotMatch(indexHtml, new RegExp('data-layout="' + oldKey + '"'), 'old layout key should not appear in the toolbar');
  assert.doesNotMatch(indexHtml, new RegExp(oldScript), 'old script path should not be loaded');
  assert.match(pluginJs, /fabalancer: \{[\s\S]*?getModule: function \(\) \{ return global\.PlanarVibeFABalancer; \}[\s\S]*?methodName: 'applyLayout'/, 'plugin should call the common FABalancer method');
});

test('Reweight uses the simple layout key and API name', () => {
  const oldKey = 'reweight' + 'tutte';
  assert.match(indexHtml, /data-layout="reweight"/, 'Reweight should have a toolbar button');
  assert.doesNotMatch(indexHtml, new RegExp('data-layout="' + oldKey + '"'), 'old Reweight key should not appear in the toolbar');
  assert.match(pluginJs, /reweight: \{[\s\S]*?getModule: function \(\) \{ return global\.PlanarVibeReweight; \}[\s\S]*?methodName: 'applyLayout'/, 'plugin should call the common Reweight method');
});

test('UI layouts always request outer-cycle augmentation without exposing an augmentation-mode toggle', () => {
  assert.doesNotMatch(indexHtml, /outer-cycle-augmentation-toggle/, 'augmentation mode checkbox should not be rendered');
  assert.doesNotMatch(indexHtml, /Aug\+/, 'Aug+ mode label should not be rendered');
  assert.doesNotMatch(pluginJs, /PREF_OUTER_CYCLE_AUGMENTATION_KEY|useOuterCycleAugmentation|setOuterCycleAugmentationEnabled/, 'plugin should not keep UI augmentation-mode state');
  assert.match(
    pluginJs,
    /function sharedLayoutMethodOptions\(overrides\) \{[\s\S]*?\{ augmentationMethod: 'outer-cycle' \}[\s\S]*?overrides \|\| \{\}/,
    'shared UI layout options should always pass outer-cycle while preserving other overrides'
  );
  assert.match(
    pluginJs,
    /fpp: \{[\s\S]*?methodName: 'applyLayout'[\s\S]*?buildMethodOptions: function \(\) \{[\s\S]*?return sharedLayoutMethodOptions\(\);/,
    'FPP should use the shared UI layout options'
  );
  assert.match(
    pluginJs,
    /schnyder: \{[\s\S]*?methodName: 'applyLayout'[\s\S]*?buildMethodOptions: function \(\) \{[\s\S]*?return sharedLayoutMethodOptions\(\);/,
    'Schnyder should use the shared UI layout options'
  );
});

test('Loading a graph clears the active layout button and seed layouts do not mark one active', () => {
  assert.match(
    pluginJs,
    /function drawGraph\(\) \{[\s\S]*?currentParsed = global\.PlanarVibePlugin\.parseEdgeList[\s\S]*?clearCurrentDebugState\(\);[\s\S]*?clearSelectedLayoutButton\(\);/,
    'drawGraph should clear the selected layout when replacing the graph'
  );
  assert.match(
    pluginJs,
    /applyLayout\('random', \{ suppressActiveSelection: true \}\);/,
    'automatic random seed placement should not select the Random button'
  );
  assert.match(
    pluginJs,
    /function applyDeterministicPositionsToCy\(parsed\) \{[\s\S]*?assignDeterministicPositionsForParsed\(parsed\)[\s\S]*?fitCurrentDrawingViewport\(\);[\s\S]*?\}/,
    'static graph loading should seed deterministic positions synchronously before tearing down Cytoscape'
  );
  assert.match(
    pluginJs,
    /if \(!cy\) \{[\s\S]*?if \(!applyParsedPositionsIfAny\(\)\) \{[\s\S]*?applyDeterministicPositionsToCy\(currentParsed\);[\s\S]*?setInteractiveMode\(false, false, true\);/,
    'static graph loading should not schedule a delayed random layout against a temporary Cytoscape instance'
  );
  assert.match(
    pluginJs,
    /if \(!opts\.suppressActiveSelection\) \{[\s\S]*?setSelectedLayoutButton\(layoutName\);[\s\S]*?\}/,
    'applyLayout should only mark active for explicit layout requests'
  );
  assert.match(
    pluginJs,
    /function setSelectedLayoutButton\(layoutName\) \{[\s\S]*?attr\('aria-pressed', 'false'\)[\s\S]*?attr\('aria-pressed', 'true'\);/,
    'active layout state should be reflected with aria-pressed'
  );
  assert.doesNotMatch(pluginJs, /planarvibe_active_layout|PREF_ACTIVE_LAYOUT|writeStorage\([^)]*layout/i, 'active layout state should not be persisted');
});

test('Drawing controls use a unified responsive action bar', () => {
  assert.match(indexHtml, /<div class="drawing-action-bar" aria-label="Drawing actions">/, 'drawing controls should be grouped in one action bar');
  assert.equal((indexHtml.match(/draw-tool-btn/g) || []).length, 5, 'icon drawing actions should share the draw-tool-btn class');
  assert.match(indexHtml, /<label class="debug-augmentation-toggle"[\s\S]*?<input id="show-augmentation-toggle" type="checkbox">[\s\S]*?<img src="static\/img\/bug\.svg" alt="">/, 'debug augmentation toggle should use the bug icon');
  assert.match(indexHtml, /id="interactive-toggle-btn"[\s\S]*?title="Disable graph interaction"[\s\S]*?aria-label="Disable graph interaction"/, 'interaction toggle should use plain enable/disable wording');
  assert.doesNotMatch(indexHtml, /Toggle Cytoscape interactivity|Cytoscape\.js/, 'user-facing tooltips should not mention Cytoscape');
  assert.match(pluginJs, /var interactionLabel = isInteractive \? 'Disable graph interaction' : 'Enable graph interaction';[\s\S]*?\.attr\('title', interactionLabel\)[\s\S]*?\.attr\('aria-label', interactionLabel\)/, 'interaction toggle label should track the current state');
  assert.doesNotMatch(indexHtml, /status-current/, 'status bar should remain a simple scrollback');
  assert.doesNotMatch(pluginJs, /status-current/, 'plugin should not maintain a separate active status message');
  assert.match(appCss, /\.drawing-action-bar \{[\s\S]*?display: flex;[\s\S]*?flex-wrap: wrap;/, 'drawing action bar should wrap across narrow widths');
  assert.match(appCss, /@media \(max-width: 768px\) \{[\s\S]*?\.drawing-action-bar \{[\s\S]*?right: 8px;[\s\S]*?\}/, 'mobile action bar should span the drawing panel');
  assert.match(appCss, /\.app-shell button:focus-visible,[\s\S]*?\.app-shell textarea:focus-visible \{[\s\S]*?outline: 3px solid var\(--pv-focus\);/, 'controls should share a visible keyboard focus style');
  assert.match(appCss, /\.debug-augmentation-toggle input:focus-visible \+ img \{[\s\S]*?outline: 3px solid var\(--pv-focus\);/, 'bug toggle should only show focus styling for keyboard-visible focus');
});

test('Sample graph selectors stay compact without redundant tooltips', () => {
  assert.doesNotMatch(indexHtml, /class="form-select form-select-sm sample-select" title=/, 'sample graph selectors should not show native browser tooltips');
  assert.match(appCss, /\.sample-select \{[\s\S]*?width: 154px;/, 'desktop sample graph selectors should be wide enough for their labels');
});

test('Main panels and the status bar stay in page flow instead of overlapping', () => {
  assert.match(appCss, /body \{[\s\S]*?overflow: hidden;/, 'desktop page should not get a document-level scrollbar');
  assert.match(appCss, /\.app-shell \{[\s\S]*?height: 100vh;[\s\S]*?grid-template-rows: auto minmax\(0, 1fr\) auto;/, 'desktop shell should reserve fixed rows for logo, main content, and status');
  assert.match(appCss, /#drawing-stats-panel \{[\s\S]*?overflow: visible;/, 'Drawing Stats title should not be clipped by its panel');
  assert.match(appCss, /\.status-row > section \{[\s\S]*?padding-top: 8px;/, 'status row should reserve only the room needed for its floating panel title');
  assert.match(appCss, /@media \(max-width: 768px\) \{[\s\S]*?body \{[\s\S]*?overflow: auto;[\s\S]*?\.app-shell \{[\s\S]*?height: auto;[\s\S]*?grid-template-rows: auto auto auto;/, 'mobile can use normal page scrolling');
});
