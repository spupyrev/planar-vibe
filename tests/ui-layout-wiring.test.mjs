import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const indexHtml = fs.readFileSync('index.html', 'utf8');
const pluginJs = fs.readFileSync('static/js/planarvibe-plugin.js', 'utf8');

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
    /if \(!opts\.suppressActiveSelection\) \{[\s\S]*?setSelectedLayoutButton\(layoutName\);[\s\S]*?\}/,
    'applyLayout should only mark active for explicit layout requests'
  );
});
