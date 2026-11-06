// MUSE's documented multipart contract has no separate negative_prompt field.
// Keep these constraints inside the supported prompt, not an invented API field.
export const qualityRules = `
QUALITY AND NEGATIVE CONSTRAINTS:
IDENTITY: Keep each adult's facial proportions, age, skin tone, hairline, hairstyle, eye shape, outfit and voice constant through all frames. Do not swap, blend, duplicate or morph faces. No face flicker, changing teeth, wandering pupils, crossed eyes, rubber skin, beauty-filter shifts or exaggerated facial distortion. Natural restrained emotion; no sudden swollen red nose, new makeup or changing tear streaks.
ANATOMY: Stable human proportions and joints. Every visible hand has five separate anatomically correct fingers attached to one wrist. No extra, missing, fused, elongated or broken fingers; no extra limbs, detached hands, twisted wrists, intersecting bodies or floating objects. Use small, slow gestures and relaxed hands. Do not stage touching faces, grabbing wrists, handshakes, passing objects between hands or intricate finger actions.
CONTINUITY: Preserve screen-left/screen-right positions, camera axis, clothing, bag, bracelet, watch, background geometry and lighting. An object stays in the same hand or location until a clearly visible natural action moves it. No teleporting, object duplication, disappearing straps, bracelet becoming fingers, bag melting into clothes, prop popping, motion jumps, abrupt zoom, camera flip, shot reset, jump cut, dissolve or sudden new person. Do not reproduce defects from a reference as new features. Match the provided opening composition without inventing new props.
SPEECH: Exactly one specified speaker per scene. Only that speaker moves their lips during the quoted Indonesian line; other characters listen with lips closed. No shared voice, speaker reversal, overlapping voices, extra words, repeated words, English, narration or off-screen dialogue. Match visible mouth movements to the spoken syllables; no silent moving mouth, frozen mouth during speech, delayed lip movement or unnatural jaw motion. Speak once at a natural calm pace within seconds 2–7; use seconds 0–2 and 7–10 for silent reactions. Do not cut off a word at a scene boundary.
CAMERA: One continuous stable medium two/three-shot for ten seconds. Keep faces unobstructed. At most a very slow small push-in after the first second; no pans, spins, montage, focus pumping, blur bursts or new establishing shot. Subtle room ambience only; no music swell or sound effects that obscure dialogue.
No text, subtitles, captions, logos, watermarks, borders or split screen.
`;

export const strictScenes = [
  `In the office lobby Nara holds one paper food bag steadily at waist height. Arga stands beside her. The same office manager, an adult woman with short auburn hair, glasses, burgundy blouse and black blazer, stands across from them. All remain in their original positions. Nara looks toward the manager; only NARA speaks: "Permisi, saya antar pesanan." Arga and the manager listen silently. End on a calm readable three-shot with hands still.`,
  `Continue directly from the previous ending, same three adults and spatial arrangement. Nara keeps holding the same bag. The manager gives a restrained disapproving look, without touching anyone or pointing. Only the MANAGER speaks: "Pengantaran lewat belakang, ya." Nara looks disappointed; Arga notices silently. No other speech. Keep everyone standing and visible.`,
  `Continue directly from the previous ending. Arga turns his gaze toward the manager and speaks calmly without stepping across Nara. Only ARGA speaks: "Sebentar. Dia tamu saya." The manager gives a small nod and remains quietly in the background. Nara looks up at Arga with surprise. No walking away, confrontation or object handling.`,
  `Continue directly from the previous ending. Nara's existing red braided bracelet remains on her wrist while her hand stays relaxed on the food-bag handle. Arga glances toward it without touching it. Only NARA speaks: "Gelang ini dari anak yang dulu saya tolong." Arga reacts with quiet recognition, mouth closed. No bag handover, bracelet removal or insert shot.`,
  `Continue directly from the previous ending. Keep the same bracelet on Nara's wrist; it is the only bracelet prop needed. Arga looks into Nara's eyes, both his hands relaxed, no pocket reach or prop reveal. Only ARGA speaks: "Anak itu aku, Nara. Aku selalu mengingatmu." Nara reacts silently, surprised but with natural restrained facial expression.`,
  `Continue directly from the previous ending. Arga and Nara hold warm eye contact; the same manager stays quietly in the background. No hand contact or new props. Only ARGA speaks: "Sekarang, izinkan aku membalas kebaikanmu." Nara listens with lips closed, then gives a small grateful smile. Finish on the same stable composition with quiet romantic emotion.`,
];

export const strictCaptions = [
  [[2,7,'Nara: Permisi, saya antar pesanan.']],
  [[2,7,'Pengantaran lewat belakang, ya.']],
  [[2,7,'Arga: Sebentar. Dia tamu saya.']],
  [[2,7,'Nara: Gelang ini dari anak yang dulu saya tolong.']],
  [[2,7,'Arga: Anak itu aku, Nara. Aku selalu mengingatmu.']],
  [[2,7,'Arga: Sekarang, izinkan aku membalas kebaikanmu.']],
];
