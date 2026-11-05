export interface VideoMenuButton { text: string; callback_data: string }
export interface VideoMenuScreen { text: string; rows: VideoMenuButton[][] }

export const VIDEO_FAMILIES = [
  { id: 'kling', label: 'Kling' },
  { id: 'seedance', label: 'Seedance' },
  { id: 'veo', label: 'Veo' },
  { id: 'wan', label: 'Wan' },
  { id: 'minimax', label: 'MiniMax' },
  { id: 'gemini', label: 'Gemini Omni' },
  { id: 'ltx', label: 'LTX' },
  { id: 'grok', label: 'Grok' },
  { id: 'pixverse', label: 'PixVerse' },
  { id: 'runway', label: 'Runway' },
  { id: 'sora', label: 'Sora' },
  { id: 'heygen', label: 'Heygen' },
  { id: 'creatify', label: 'Creatify' },
  { id: 'vela', label: 'Vela AI' },
  { id: 'muse', label: 'MUSE AI' },
] as const;
export type VideoFamilyId = typeof VIDEO_FAMILIES[number]['id'];
const FAMILY_PREFIX = 'menu_video_family_';
const button = (text: string, callback_data: string): VideoMenuButton => ({ text, callback_data });

export function videoFamilyForCallback(data: string): VideoFamilyId | undefined {
  if (data === 'mode_bvideo_vela') return 'vela';
  if (data === 'mode_bvideo_muse') return 'muse';
  if (data === 'mode_bvideo_deapi_ltx') return 'ltx';
  if (data === 'mode_bvideo_deapi_h3') return 'minimax';
  if (data === 'menu_kling_list' || data.startsWith('mode_pi2v_kling_')
    || ['mode_kling21', 'mode_kling21p2'].includes(data)) return 'kling';
  if (data.startsWith('mode_pi2v_seedance_')
    || ['mode_oneover_seedance25', 'mode_seedance25_p2', 'mode_china_seedance2',
      'mode_flora_seedance_2_480'].includes(data)) return 'seedance';
  if (['mode_veofast', 'mode_veolite', 'mode_veo31'].includes(data)) return 'veo';
  if (data.startsWith('mode_pi2v_wan_')
    || ['mode_china_wan3', 'mode_flora_wan_v3_480'].includes(data)) return 'wan';
  if (['mode_china_minimax_h3', 'mode_flora_minimax_h3_480', 'mode_minimax_h3'].includes(data)) return 'minimax';
  if (['mode_gomni', 'mode_gomni12', 'mode_gomni11_flora'].includes(data)) return 'gemini';
  if (['mode_pi2v_ltx_pro', 'mode_pi2v_ltx_fast'].includes(data)) return 'ltx';
  const singleModels: Record<string, VideoFamilyId> = {
    mode_pi2v_grok_imagine: 'grok', mode_pi2v_pixverse_v6: 'pixverse',
    mode_rw: 'runway', mode_sora: 'sora', mode_har_heygen: 'heygen',
    mode_pi2v_creatify_boreal: 'creatify',
  };
  return singleModels[data];
}

/** Keep every existing generation callback; navigation never starts a paid job. */
export function buildVideoMenuScreen(data: string, modelRows: VideoMenuButton[][]): VideoMenuScreen | undefined {
  if (data !== 'menu_video' && !data.startsWith(FAMILY_PREFIX)) return;
  const selected = data === 'menu_video' ? undefined
    : VIDEO_FAMILIES.find(f => f.id === data.slice(FAMILY_PREFIX.length));
  if (data !== 'menu_video' && !selected) return;
  const grouped = new Map<VideoFamilyId, VideoMenuButton[][]>(VIDEO_FAMILIES.map(f => [f.id, []]));
  const seen = new Set<string>();
  for (const model of modelRows.flat()) {
    const family = videoFamilyForCallback(model.callback_data);
    if (!family) throw Error(`VIDEO_MENU_UNMAPPED_CALLBACK: ${model.callback_data}`);
    if (seen.has(model.callback_data)) throw Error(`VIDEO_MENU_DUPLICATE_CALLBACK: ${model.callback_data}`);
    seen.add(model.callback_data);
    grouped.get(family)!.push([{ ...model, text: model.text.replace(/\s+[•·]\s+/g, ' · ') }]);
  }
  if (selected) {
    return {
      text: `Generate Video · ${selected.label}\n\nPilih model atau varian di bawah.\nDetail pengaturan dan harga ditampilkan sebelum generate.`,
      rows: [
        ...grouped.get(selected.id)!,
        [button('Kembali ke Daftar Model', 'menu_video')],
        [button('Menu Utama', 'back_main')],
      ],
    };
  }
  const buttons = VIDEO_FAMILIES.filter(f => grouped.get(f.id)!.length)
    .map(f => button(f.label, `${FAMILY_PREFIX}${f.id}`));
  const rows: VideoMenuButton[][] = [];
  for (let i = 0; i < buttons.length; i += 2) rows.push(buttons.slice(i, i + 2));
  return {
    text: 'Generate Video\n\nPilih keluarga model untuk melihat semua variannya.\nSetelah memilih model, ikuti langkah pengaturan videonya.',
    rows: [...rows, [button('Menu Utama', 'back_main')]],
  };
}
