/**
 * @file options-service-catalog.js
 * 模型服务目录化交互控制器：左侧分组目录检索 + 右侧统一 Hero 详情工作区。
 * 交互层只编排既有面板（订阅面板 / API 面板与表单），不持有服务状态本身。
 */

import {API_PROVIDERS} from '../api-providers.mjs';
import {providerIconUrl} from './provider-icons.js';

export const CATALOG_CATEGORIES = [
  {id: 'subscription', label: '订阅通道'},
  {id: 'popular', label: '主流大模型'},
  {id: 'domestic', label: '国内精选'},
  {id: 'opensource', label: '开源与推理'},
  {id: 'cloud', label: '企业云服务'},
  {id: 'custom', label: '自定义 API'},
];

// 订阅通道条目：与 subscription.js 的 SUBSCRIPTION_KINDS 保持一致；local 为本机模型通道。
const SUBSCRIPTION_TEMPLATES = [
  {id: 'chatgpt', name: 'ChatGPT 订阅', category: 'subscription', icon: 'openai', desc: '免 API Key，通过本机连接器使用 Codex 权益', website: 'https://chatgpt.com', keyOptional: true},
  {id: 'grok', name: 'Grok 订阅', category: 'subscription', icon: 'xai', desc: '免 API Key，通过 SuperGrok 或 X Premium+ 直连', website: 'https://x.ai', keyOptional: true},
  {id: 'antigravity', name: 'Google 订阅', category: 'subscription', icon: 'google', desc: '免 API Key，通过 Google AI Pro / Ultra 的 Antigravity 权益', website: 'https://gemini.google.com', keyOptional: true},
  {id: 'local', name: '本机模型', category: 'subscription', icon: 'google', desc: 'Gemini Nano 端侧模型：离线、免密钥，只接简短查词提示', website: '', keyOptional: true},
];

// 目录元数据：分类、简介与官方密钥页。未列出的服务商归入自定义，不影响使用。
const PROVIDER_CATALOG_META = {
  openai: {category: 'popular', desc: 'GPT 系列官方 API 接口', website: 'https://platform.openai.com/api-keys'},
  deepseek: {category: 'popular', desc: '深度求索大模型，高性价比的阅读理解与解构', website: 'https://platform.deepseek.com'},
  google: {category: 'popular', desc: 'Gemini 系列官方接口，高吞吐低延迟', website: 'https://aistudio.google.com/app/apikey'},
  anthropic: {category: 'popular', desc: 'Claude 系列官方 API 接口', website: 'https://console.anthropic.com/settings/keys'},
  xai: {category: 'popular', desc: 'xAI 官方 Grok API 接口', website: 'https://console.x.ai'},
  requesty: {category: 'popular', desc: 'Requesty 路由上的 Jev 判定模型，结构化领域识别', website: 'https://app.requesty.ai'},
  minimax: {category: 'domestic', desc: 'MiniMax 系列国内多模态大模型', website: 'https://platform.minimaxi.com'},
  siliconflow: {category: 'domestic', desc: '多模型聚合平台，DeepSeek 与 Qwen 开源全家桶', website: 'https://cloud.siliconflow.cn'},
  'siliconflow-systemone': {category: 'domestic', desc: 'System One 快速决策模型，结构化判定（Alpha 限时免费）', website: 'https://cloud.siliconflow.cn'},
  volcengine: {category: 'domestic', desc: '火山引擎豆包大模型官方接口', website: 'https://console.volcengine.com/ark'},
  alibaba: {category: 'domestic', desc: '阿里云百炼通义千问兼容接口', website: 'https://bailian.console.aliyun.com'},
  moonshotai: {category: 'domestic', desc: '月之暗面 Kimi 超长上下文模型', website: 'https://platform.moonshot.cn'},
  stepfun: {category: 'domestic', desc: '阶跃星辰 Step 系列模型官方接口', website: 'https://platform.stepfun.com'},
  tensdaq: {category: 'domestic', desc: 'Qwen3 结构化优化 API 专线', website: ''},
  ollama: {category: 'opensource', desc: '本机运行开源模型，完全离线', website: 'https://ollama.com', keyOptional: true},
  openrouter: {category: 'opensource', desc: '全球模型一站式聚合网关', website: 'https://openrouter.ai/keys'},
  huggingface: {category: 'opensource', desc: '开源社区推理 API', website: 'https://huggingface.co/settings/tokens'},
  groq: {category: 'opensource', desc: 'LPU 加速的超快推理', website: 'https://console.groq.com/keys'},
  fireworks: {category: 'opensource', desc: '快速开源模型云端推理', website: 'https://fireworks.ai'},
  mistral: {category: 'opensource', desc: '高效欧洲开源模型 API', website: 'https://console.mistral.ai'},
  togetherai: {category: 'opensource', desc: '开源模型云端运行平台', website: 'https://api.together.xyz'},
  cerebras: {category: 'opensource', desc: '晶圆级芯片的极速推理', website: 'https://cloud.cerebras.ai'},
  deepinfra: {category: 'opensource', desc: '高性价比开源模型托管', website: 'https://deepinfra.com'},
  azure: {category: 'cloud', desc: '微软企业级托管 OpenAI 实例', website: 'https://portal.azure.com'},
  bedrock: {category: 'cloud', desc: '亚马逊企业级模型托管', website: 'https://aws.amazon.com/bedrock'},
  cohere: {category: 'cloud', desc: '企业级语义理解 Command 模型', website: 'https://dashboard.cohere.com'},
  perplexity: {category: 'cloud', desc: '联网增强搜索模型接口', website: 'https://www.perplexity.ai/settings/api'},
  replicate: {category: 'cloud', desc: '容器化开源模型运行网关', website: 'https://replicate.com'},
  vercel: {category: 'cloud', desc: 'Vercel 托管 AI 网关', website: 'https://vercel.com'},
  jalapenocloud: {category: 'cloud', desc: '云端模型托管与推理加速', website: ''},
  atlascloud: {category: 'cloud', desc: '高性能云端模型托管', website: ''},
  'openai-compatible': {category: 'custom', desc: '兼容 OpenAI Chat Completions 的任意端点', website: ''},
  'open-responses': {category: 'custom', desc: '兼容 OpenAI Responses 格式的自定义端点', website: ''},
};

// 目录模板由服务商清单派生，新增服务商无需改动这里即可出现在目录中（归入自定义）。
export const CATALOG_TEMPLATES = [
  ...SUBSCRIPTION_TEMPLATES,
  ...API_PROVIDERS.map(provider => {
    const meta = PROVIDER_CATALOG_META[provider.id];
    return {
      id: provider.id,
      name: provider.name,
      category: meta?.category || 'custom',
      icon: provider.id,
      desc: meta?.desc || (provider.baseUrl || '自定义端点'),
      website: meta?.website || provider.apiKeyUrl || '',
      keyOptional: provider.keyOptional === true,
    };
  }),
];

// 图标回退与 API 挑选器共用一张表（ui/provider-icons.js），避免两处各写一份。
export function iconUrlFor(iconName) {
  return providerIconUrl(iconName);
}

const SUBSCRIPTION_IDS = new Set(SUBSCRIPTION_TEMPLATES.map(item => item.id));

class ServiceCatalogController {
  constructor() {
    this.selectedKey = '';
    this.searchQuery = '';
    this.initialized = false;
    this.userSelected = false;
  }

  init() {
    if (this.initialized) return;
    this.initialized = true;
    this.railList = document.querySelector('#catalog-directory-list');
    this.searchInput = document.querySelector('#catalog-search-input');
    this.addBtn = document.querySelector('#catalog-add-btn');
    this.heroIcon = document.querySelector('#catalog-hero-icon img');
    this.heroTitle = document.querySelector('#catalog-hero-title');
    this.heroBadge = document.querySelector('#catalog-hero-active-badge');
    this.setDefaultBtn = document.querySelector('#catalog-hero-set-default');
    this.docLink = document.querySelector('#catalog-hero-website');
    this.heroDesc = document.querySelector('#catalog-hero-desc');
    this.checkConnBtn = document.querySelector('#catalog-check-conn-btn');
    this.checkBtnLabel = document.querySelector('#catalog-check-btn-label');
    this.countEl = document.querySelector('#catalog-service-count');

    this.searchInput?.addEventListener('input', () => {
      this.searchQuery = this.searchInput.value.trim().toLowerCase();
      this.renderRailList();
    });
    this.addBtn?.addEventListener('click', () => this.triggerNewCustomService());
    this.setDefaultBtn?.addEventListener('click', () => void this.makeCurrentServiceDefault());
    this.checkConnBtn?.addEventListener('click', () => this.triggerCheckConnection());
  }

  getCurrentState() {
    return globalThis.optionsState?.settings || {};
  }

  isSubscriptionKey(key) { return SUBSCRIPTION_IDS.has(key); }

  renderRailList() {
    this.init();
    if (!this.railList) return;
    const settings = this.getCurrentState();
    const currentKind = settings.providerKind || 'chatgpt';
    const activeServiceId = settings.activeApiServiceId || '';
    const savedServices = settings.apiServices || [];

    // 用户自建服务合并进目录：与内置模板同名出现多次，或不在模板中时单列一条。
    const allItems = [...CATALOG_TEMPLATES];
    savedServices.forEach(service => {
      const isTemplateMatch = CATALOG_TEMPLATES.some(template => template.id === service.providerId);
      if (!isTemplateMatch || savedServices.filter(item => item.providerId === service.providerId).length > 1) {
        allItems.push({
          id: `saved:${service.id}`,
          name: service.name || '未命名服务',
          category: 'custom',
          icon: service.providerId || 'custom-api',
          desc: `${service.model || '未设模型'} · ${service.baseUrl || ''}`,
          website: '',
          savedInstance: service,
        });
      }
    });

    if (this.countEl) this.countEl.textContent = String(allItems.length);

    this.railList.replaceChildren();
    for (const category of CATALOG_CATEGORIES) {
      const groupItems = allItems.filter(item => {
        if (item.category !== category.id) return false;
        if (!this.searchQuery) return true;
        return item.name.toLowerCase().includes(this.searchQuery)
          || item.id.toLowerCase().includes(this.searchQuery)
          || (item.desc && item.desc.toLowerCase().includes(this.searchQuery));
      });
      if (!groupItems.length) continue;

      const section = document.createElement('div');
      section.className = 'directory-section';
      const heading = document.createElement('div');
      heading.className = 'directory-section-heading';
      const label = document.createElement('span');
      label.textContent = category.label;
      const size = document.createElement('small');
      size.textContent = String(groupItems.length);
      heading.append(label, size);
      section.append(heading);

      const items = document.createElement('div');
      items.className = 'directory-items';
      for (const item of groupItems) {
        const button = document.createElement('button');
        button.type = 'button';
        button.className = 'service-item';
        button.dataset.serviceKey = item.id;
        if (this.selectedKey === item.id) button.classList.add('is-selected');

        const isDefault = this.isSubscriptionKey(item.id)
          ? currentKind === item.id
          : item.id.startsWith('saved:')
            ? currentKind === 'api' && activeServiceId === item.savedInstance?.id
            : currentKind === 'api' && savedServices.find(service => service.id === activeServiceId)?.providerId === item.id;
        const isConfigured = this.isSubscriptionKey(item.id)
          ? false
          : item.id.startsWith('saved:')
            ? Boolean(item.savedInstance?.apiKey)
            : Boolean(savedServices.find(service => service.providerId === item.id)?.apiKey);

        const icon = document.createElement('div');
        icon.className = 'service-icon-box';
        const image = document.createElement('img');
        image.src = iconUrlFor(item.icon);
        image.alt = '';
        image.width = 20;
        image.height = 20;
        image.loading = 'lazy';
        icon.append(image);

        const copy = document.createElement('div');
        copy.className = 'service-copy';
        const name = document.createElement('strong');
        name.className = 'service-name';
        name.textContent = item.name;
        const desc = document.createElement('small');
        desc.className = 'service-desc';
        desc.textContent = item.desc || '';
        copy.append(name, desc);

        const status = document.createElement('div');
        status.className = 'service-status-col';
        if (isDefault) {
          const badge = document.createElement('span');
          badge.className = 'service-badge is-default';
          badge.textContent = '默认';
          status.append(badge);
        } else if (isConfigured) {
          const badge = document.createElement('span');
          badge.className = 'service-badge is-configured';
          badge.textContent = '已配置';
          status.append(badge);
        }

        button.append(icon, copy, status);
        button.addEventListener('click', () => this.selectService(item.id));
        items.append(button);
      }
      section.append(items);
      this.railList.append(section);
    }

    this.syncHeroDetail();
  }

  selectService(key) {
    if (typeof globalThis.optionsDiscardProviderDraft === 'function' && !globalThis.optionsDiscardProviderDraft()) {
      return;
    }
    this.userSelected = true;
    this.selectedKey = key;
    this.railList?.querySelectorAll('.service-item').forEach(element => {
      element.classList.toggle('is-selected', element.dataset.serviceKey === key);
    });

    const settings = this.getCurrentState();
    const savedServices = settings.apiServices || [];
    const subscriptionPanel = document.querySelector('#subscription-panel');
    const apiPanel = document.querySelector('#api-panel');
    const localPanel = document.querySelector('#local-panel');

    if (key === 'local') {
      if (subscriptionPanel) subscriptionPanel.hidden = true;
      if (apiPanel) apiPanel.hidden = true;
      if (localPanel) localPanel.hidden = false;
      if (typeof globalThis.optionsSetDraftServiceId === 'function') {
        globalThis.optionsSetDraftServiceId(null);
      }
      this.syncHeroDetail();
      document.querySelector('#nano-refresh')?.click();
      return;
    }
    if (localPanel) localPanel.hidden = true;

    if (this.isSubscriptionKey(key)) {
      if (subscriptionPanel) subscriptionPanel.hidden = false;
      if (apiPanel) apiPanel.hidden = true;
      if (typeof globalThis.optionsSetDraftServiceId === 'function') {
        globalThis.optionsSetDraftServiceId(null);
      }
      this.syncHeroDetail();
      return;
    }

    if (subscriptionPanel) subscriptionPanel.hidden = true;
    if (apiPanel) apiPanel.hidden = false;

    if (key.startsWith('saved:')) {
      const serviceId = key.slice('saved:'.length);
      this.displaySavedService(serviceId);
    } else {
      const match = savedServices.find(service => service.providerId === key);
      if (match) {
        this.displaySavedService(match.id);
      } else {
        this.startDraftProvider(key);
      }
    }
    this.syncHeroDetail();
  }

  displaySavedService(serviceId) {
    if (typeof globalThis.optionsShowSavedService === 'function') {
      globalThis.optionsShowSavedService(serviceId);
    } else {
      const select = document.querySelector('#api-service-select');
      if (select && select.value !== serviceId) {
        select.value = serviceId;
        select.dispatchEvent(new Event('change', {bubbles: true}));
      }
    }
    const editor = document.querySelector('#api-editor');
    if (editor) editor.open = true;
  }

  startDraftProvider(providerId) {
    if (typeof globalThis.optionsStartDraftProvider === 'function') {
      globalThis.optionsStartDraftProvider(providerId);
    } else {
      const cancelButton = document.querySelector('#cancel-api-service');
      if (cancelButton?.hidden) document.querySelector('#new-api-service')?.click();
      const providerSelect = document.querySelector('#provider-id');
      if (providerSelect) {
        providerSelect.value = providerId;
        providerSelect.dispatchEvent(new Event('change', {bubbles: true}));
      }
    }
    const editor = document.querySelector('#api-editor');
    if (editor) editor.open = true;
  }

  syncHeroDetail() {
    const key = this.selectedKey;
    const settings = this.getCurrentState();
    const currentKind = settings.providerKind || 'chatgpt';
    const activeServiceId = settings.activeApiServiceId || '';
    const savedServices = settings.apiServices || [];

    let item = CATALOG_TEMPLATES.find(template => template.id === key);
    if (!item && key.startsWith('saved:')) {
      const service = savedServices.find(entry => entry.id === key.slice('saved:'.length));
      if (service) item = {id: key, name: service.name, icon: service.providerId || 'custom-api', desc: `${service.model || ''} · ${service.baseUrl || ''}`, website: ''};
    }
    if (!item) item = CATALOG_TEMPLATES[0];

    if (this.heroTitle) this.heroTitle.textContent = item.name;
    if (this.heroDesc) this.heroDesc.textContent = item.desc || '';
    if (this.heroIcon) this.heroIcon.src = iconUrlFor(item.icon);

    const isDefault = this.isSubscriptionKey(key)
      ? currentKind === key
      : key.startsWith('saved:')
        ? currentKind === 'api' && activeServiceId === key.slice('saved:'.length)
        : currentKind === 'api' && savedServices.find(service => service.id === activeServiceId)?.providerId === key;

    if (this.heroBadge) this.heroBadge.hidden = !isDefault;
    if (this.setDefaultBtn) this.setDefaultBtn.hidden = isDefault;
    if (this.docLink) {
      if (item.website) {
        this.docLink.href = item.website;
        this.docLink.hidden = false;
      } else this.docLink.hidden = true;
    }
    if (this.checkBtnLabel) this.checkBtnLabel.textContent = this.isSubscriptionKey(key) ? '刷新连接与状态' : '检查服务连接';
  }

  async makeCurrentServiceDefault() {
    const key = this.selectedKey;
    const settings = this.getCurrentState();
    const savedServices = settings.apiServices || [];

    if (this.isSubscriptionKey(key)) {
      if (typeof globalThis.optionsSavePatch === 'function') {
        const saved = await globalThis.optionsSavePatch({providerKind: key}, '已切换至 ' + (CATALOG_TEMPLATES.find(item=>item.id===key)?.name||'订阅服务'));
        if (!saved) return;
      } else {
        const radio = document.querySelector(`input[name="provider-kind"][value="${key}"]`);
        if (radio) {
          radio.checked = true;
          radio.dispatchEvent(new Event('change', {bubbles: true}));
        }
      }
      this.userSelected = false;
      this.sync();
      return;
    }

    const targetServiceId = key.startsWith('saved:')
      ? key.slice('saved:'.length)
      : savedServices.find(service => service.providerId === key)?.id || '';
    if (targetServiceId) {
      const target = savedServices.find(s => s.id === targetServiceId);
      if (typeof globalThis.optionsSavePatch === 'function') {
        const saved = await globalThis.optionsSavePatch({providerKind: 'api', activeApiServiceId: targetServiceId}, '已切换到 ' + (target?.name || '服务'));
        if (!saved) return;
      } else {
        const select = document.querySelector('#api-service-select');
        if (select) {
          select.value = targetServiceId;
          select.dispatchEvent(new Event('change', {bubbles: true}));
        }
      }
      this.userSelected = false;
      this.sync();
      return;
    }

    // 未保存过的服务商：提示先保存，再设为默认。
    const result = document.querySelector('#provider-result');
    if (result) {
      result.textContent = '请先填写接口信息并点击「保存并使用」，即可设为当前服务。';
      result.hidden = false;
    }
    document.querySelector('#provider-keys')?.focus();
  }

  triggerCheckConnection() {
    const spinIcon = this.checkConnBtn?.querySelector('.check-spin-icon');
    spinIcon?.classList.add('is-spinning');
    if (this.selectedKey === 'local') document.querySelector('#nano-refresh')?.click();
    else if (this.isSubscriptionKey(this.selectedKey)) document.querySelector('#refresh-subscription')?.click();
    else document.querySelector('#test-provider')?.click();
    setTimeout(() => spinIcon?.classList.remove('is-spinning'), 1200);
  }

  triggerNewCustomService() {
    if (typeof globalThis.optionsDiscardProviderDraft === 'function' && !globalThis.optionsDiscardProviderDraft()) return;
    this.userSelected = true;
    this.selectedKey = 'openai-compatible';
    this.startDraftProvider('openai-compatible');
    this.renderRailList();
    document.querySelector('#provider-trigger')?.focus();
  }

  sync() {
    this.init();
    const settings = this.getCurrentState();
    const currentKind = settings.providerKind || 'chatgpt';
    const activeServiceId = settings.activeApiServiceId || '';
    const savedServices = settings.apiServices || [];

    if (!this.userSelected || !this.selectedKey) {
      if (currentKind !== 'api') this.selectedKey = currentKind;
      else if (activeServiceId) {
        const active = savedServices.find(service => service.id === activeServiceId);
        this.selectedKey = active ? (active.providerId || `saved:${active.id}`) : (savedServices.length ? (savedServices[0].providerId || `saved:${savedServices[0].id}`) : 'openai-compatible');
      } else this.selectedKey = savedServices.length ? (savedServices[0].providerId || `saved:${savedServices[0].id}`) : 'openai-compatible';
    }
    this.renderRailList();
    // 初始同步也要落到正确的面板（目录点击之外的路径不会经过 selectService）。
    const subscriptionPanel = document.querySelector('#subscription-panel');
    const apiPanel = document.querySelector('#api-panel');
    const localPanel = document.querySelector('#local-panel');
    if (this.selectedKey === 'local') {
      if (subscriptionPanel) subscriptionPanel.hidden = true;
      if (apiPanel) apiPanel.hidden = true;
      if (localPanel) localPanel.hidden = false;
    } else if (this.isSubscriptionKey(this.selectedKey)) {
      if (subscriptionPanel) subscriptionPanel.hidden = false;
      if (apiPanel) apiPanel.hidden = true;
      if (localPanel) localPanel.hidden = true;
    } else if (localPanel) localPanel.hidden = true;
  }
}

export const serviceCatalog = new ServiceCatalogController();
