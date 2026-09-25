/**
 * @file ui/provider-icons.js
 * 服务商图标解析：icons/providers 只提供有品牌资产的 svg，其余回退到 custom-api。
 * 目录、挑选器共用同一张回退表，避免新增服务商时出现裂图。
 */

const ICON_FALLBACK = Object.freeze({
  'openai-compatible': 'custom-api',
  'open-responses': 'custom-api',
  jalapenocloud: 'custom-api',
  requesty: 'custom-api',
  tensdaq: 'custom-api',
  'siliconflow-systemone': 'custom-api',
});

export function providerIconFile(providerId) {
  return ICON_FALLBACK[providerId] || providerId || 'custom-api';
}

export function providerIconUrl(providerId) {
  return `../icons/providers/${providerIconFile(providerId)}.svg`;
}
