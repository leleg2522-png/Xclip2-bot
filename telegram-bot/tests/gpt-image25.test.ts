import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { buildGptImage25Params, GPT_IMAGE_25_MAX_REFS } from '../src/picsart';

const first = 'https://example.test/first.png';
const refs = Array.from({ length: GPT_IMAGE_25_MAX_REFS }, (_, i) => `https://example.test/ref-${i}.png`);
assert.equal(GPT_IMAGE_25_MAX_REFS, 10);

for (const model of ['gpt-image-2.5-sunburst', 'gpt-image-2.5-flare'] as const) {
  const params = buildGptImage25Params({
    model, prompt: 'A cool pose', imageUrls: [first], ratio: '9:16', outputName: 'test.png',
  }) as any;
  assert.deepEqual(params, {
    prompt: 'A cool pose',
    model,
    images: [first],
    n: 1,
    size: '1024x1824',
    quality: 'high',
    background: 'opaque',
    output_format: 'png',
    options: {
      inputs_transformation: { downscale_oversized_images: true },
      drive: {
        name: 'test.png',
        attributes: {
          model,
          aiSDKPayload: JSON.stringify({
            prompt: 'A cool pose',
            aspectRatio: '9:16',
            quality: 'high',
            background: 'opaque',
            outputFormat: 'png',
            count: 1,
            imageUrls: [first],
          }),
          appId: 'com.picsart.ai-playground',
          appType: 'miniapp',
        },
        folder: { path: 'AI Playground' },
      },
    },
  });
  const ten = buildGptImage25Params({
    model, prompt: 'Combine these images', imageUrls: refs, ratio: '16:9', outputName: 'ten.png',
  }) as any;
  assert.equal(ten.images.length, 10);
  assert.equal(ten.size, '1824x1024');
  assert.deepEqual(JSON.parse(ten.options.drive.attributes.aiSDKPayload).imageUrls, refs);
  assert.throws(() => buildGptImage25Params({
    model, prompt: 'Too many', imageUrls: [...refs, first], ratio: '1:1',
  }), /PICSART_TOO_MANY_REFERENCE_IMAGES/);
  const textOnly = buildGptImage25Params({
    model, prompt: 'A new image', imageUrls: [], ratio: '1:1', outputName: 'text.png',
  }) as any;
  assert.equal(textOnly.size, '1024x1024');
  assert.equal('images' in textOnly, false);
  assert.equal('imageUrls' in JSON.parse(textOnly.options.drive.attributes.aiSDKPayload), false);
}

const picsartSource = readFileSync(new URL('../src/picsart.ts', import.meta.url), 'utf8');
assert.match(picsartSource, /imageUrls\.length \? 'openai-image-editing' : 'openai-images-generate'/);
assert.match(picsartSource, /pollPicsartImageResult\(credId, 'openai-images-generate', id/);
assert.match(picsartSource, /gateway: true,\s+onTick:/);
assert.match(picsartSource, /PICSART_POST_SUBMIT_AUTH_LOST job=/);

const botSource = readFileSync(new URL('../src/index.ts', import.meta.url), 'utf8');
assert.match(botSource, /gpt_image_25:\s*600/);
for (const variant of ['sunburst', 'flare']) {
  assert.match(botSource, new RegExp(`mode_gpt25_${variant}`));
  assert.match(botSource, new RegExp(`GPT Image 2\\.5 ${variant === 'sunburst' ? 'Sunburst' : 'Flare'}`));
}
assert.match(botSource, /GPT_IMAGE_25_MAX_REFS/);
assert.match(botSource, /data === 'gi_no_photo'/);
assert.match(botSource, /picsart\.generateGptImage25/);
assert.match(botSource, /if \(draft\.mode !== 'gptimg_wait_prompt'\) return/);
console.log('GPT Image 2.5 Sunburst/Flare contract tests passed.');