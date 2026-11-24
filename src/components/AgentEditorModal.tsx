import { useEffect, useState, type FormEvent } from 'react'
import type {
  AgentConfig,
  ChatAgentRole,
  Provider,
  ProviderModel,
} from '../../shared/boardroom'
import { CHAT_AGENT_ROLES, isChatAgentRole } from '../../shared/chat'
import { createId } from '../createId'
import Modal from './Modal'

interface AgentEditorModalProps {
  agent: AgentConfig | null
  onClose: () => void
  onSave: (agent: AgentConfig) => void
  onDelete: (agentId: string) => void
}

interface ProviderModelState {
  provider: Provider
  status: 'loading' | 'loaded' | 'error'
  models: ProviderModel[]
  error: string
}

function defaultModel(provider: Provider): string {
  switch (provider) {
    case 'openai':
      return 'gpt-6.2-sol'
    case 'anthropic':
      return 'claude-sonnet-5-5'
    case 'openrouter':
      return 'openai/gpt-4o-mini'
    case 'magnific':
      return 'mystic:realism'
  }
}

function chatRoleLabel(role: ChatAgentRole): string {
  switch (role) {
    case 'advisor':
      return 'Meeting Member'
    case 'director':
      return 'Orchestrator'
    case 'researcher':
      return 'Researcher'
    case 'facilitator':
      return 'Facilitator'
    case 'critic':
      return 'Critic'
    case 'synthesizer':
      return 'Synthesizer'
    case 'image_processor':
      return 'Image Processor'
    case 'image_generator':
      return 'Image Generator'
    case 'image_analyser':
      return 'Image Analyser'
    case 'report_formatter':
      return 'Document Formatter'
    case 'executor':
      return 'Executor'
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isProviderModel(value: unknown): value is ProviderModel {
  return (
    isRecord(value) &&
    typeof value.id === 'string' &&
    typeof value.name === 'string' &&
    (value.isFree === undefined || typeof value.isFree === 'boolean') &&
    (value.supportsImageGeneration === undefined ||
      typeof value.supportsImageGeneration === 'boolean') &&
    (value.supportsImageProcessing === undefined ||
      typeof value.supportsImageProcessing === 'boolean') &&
    (value.supportsVision === undefined || typeof value.supportsVision === 'boolean') &&
    (value.supportsWebSearch === undefined ||
      typeof value.supportsWebSearch === 'boolean')
  )
}

function modelCapabilities(model: ProviderModel | undefined): AgentConfig['modelCapabilities'] {
  return {
    ...(model?.supportsImageGeneration
      ? { supportsImageGeneration: true }
      : {}),
    ...(model?.supportsImageProcessing
      ? { supportsImageProcessing: true }
      : {}),
    ...(model?.supportsVision ? { supportsVision: true } : {}),
    ...(model?.supportsWebSearch ? { supportsWebSearch: true } : {}),
  }
}

function AgentEditorModal({ agent, onClose, onSave, onDelete }: AgentEditorModalProps) {
  const [draft, setDraft] = useState<AgentConfig>(() =>
    agent ?? {
      id: createId(),
      name: '',
      role: '',
      defaultChatRole: 'advisor',
      provider: 'openai',
      model: defaultModel('openai'),
      modelCapabilities: {},
      knowledge: '',
      skills: '',
      instructions: '',
    },
  )
  const [providerModelState, setProviderModelState] = useState<ProviderModelState>(() => ({
    provider: agent?.provider ?? 'openai',
    status: 'loading',
    models: [],
    error: '',
  }))
  const models =
    providerModelState.provider === draft.provider ? providerModelState.models : []
  const modelStatus =
    providerModelState.provider === draft.provider ? providerModelState.status : 'loading'
  const modelError =
    providerModelState.provider === draft.provider ? providerModelState.error : ''
  const selectedModel = models.find((model) => model.id === draft.model)
  const selectedCapabilities =
    (selectedModel ? modelCapabilities(selectedModel) : draft.modelCapabilities) ?? {}

  useEffect(() => {
    const controller = new AbortController()

    async function loadModels() {
      try {
        const response = await fetch(`/api/providers/${draft.provider}/models`, {
          signal: controller.signal,
        })
        const result: unknown = await response.json()
        if (!response.ok) {
          const message =
            isRecord(result) && typeof result.error === 'string'
              ? result.error
              : 'Could not load models.'
          throw new Error(message)
        }
        if (!isRecord(result) || !Array.isArray(result.models)) {
          throw new Error('The provider returned an invalid model list.')
        }

        const loadedModels = result.models.filter(isProviderModel)
        setProviderModelState({
          provider: draft.provider,
          status: 'loaded',
          models: loadedModels,
          error: '',
        })
      } catch (error) {
        if (controller.signal.aborted) return
        setProviderModelState({
          provider: draft.provider,
          status: 'error',
          models: [],
          error: error instanceof Error ? error.message : 'Could not load models.',
        })
      }
    }

    void loadModels()
    return () => controller.abort()
  }, [draft.provider])

  function update(changes: Partial<AgentConfig>) {
    setDraft((current) => ({ ...current, ...changes }))
  }

  function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    onSave({
      ...draft,
      name: draft.name.trim(),
      role: draft.role.trim(),
      model: draft.model.trim(),
      modelCapabilities:
        models.find((model) => model.id === draft.model)
          ? modelCapabilities(models.find((model) => model.id === draft.model))
          : draft.modelCapabilities,
      knowledge: draft.knowledge.trim(),
      skills: draft.skills.trim(),
      instructions: draft.instructions.trim(),
    })
  }

  return (
    <Modal title={agent ? 'Edit advisor' : 'Add an advisor'} onClose={onClose}>
      <form className="modal-form" onSubmit={save}>
        <div className="form-grid">
          <label className="modal-field">
            Agent name
            <input
              autoFocus
              maxLength={80}
              onChange={(event) => update({ name: event.target.value })}
              placeholder="e.g. Financial advisor"
              required
              value={draft.name}
            />
          </label>
          <label className="modal-field">
            Perspective
            <input
              maxLength={120}
              onChange={(event) => update({ role: event.target.value })}
              placeholder="e.g. Finance and risk"
              required
              value={draft.role}
            />
          </label>
          <label className="modal-field">
            AI provider
            <select
              onChange={(event) => {
                const provider: Provider =
                  event.target.value === 'anthropic' ||
                  event.target.value === 'openrouter' ||
                  event.target.value === 'magnific'
                    ? event.target.value
                    : 'openai'
                update({
                  provider,
                  model: defaultModel(provider),
                  modelCapabilities: {},
                })
              }}
              value={draft.provider}
            >
              <option value="openai">OpenAI</option>
              <option value="anthropic">Anthropic</option>
              <option value="openrouter">OpenRouter</option>
              <option value="magnific">Magnific (image roles)</option>
            </select>
          </label>
          <label className="modal-field">
            Default boardroom role
            <select
              onChange={(event) => {
                if (isChatAgentRole(event.target.value)) {
                  update({ defaultChatRole: event.target.value })
                }
              }}
              value={draft.defaultChatRole}
            >
              {CHAT_AGENT_ROLES.map((role) => {
                const disabled =
                  (draft.provider === 'magnific' &&
                    role !== 'image_generator' &&
                    role !== 'image_processor') ||
                  (role === 'image_generator' &&
                    !selectedCapabilities.supportsImageGeneration) ||
                  (role === 'image_processor' &&
                    (draft.provider !== 'magnific' ||
                      !selectedCapabilities.supportsImageProcessing)) ||
                  (role === 'image_analyser' && !selectedCapabilities.supportsVision) ||
                  (role === 'researcher' && !selectedCapabilities.supportsWebSearch)
                return (
                  <option disabled={disabled} key={role} value={role}>
                    {chatRoleLabel(role)}
                  </option>
                )
              })}
            </select>
            <span className="field-hint">
              This role is preselected whenever you add this agent to a boardroom, and can be overridden per chat.
            </span>
          </label>
          <label className="modal-field">
            Model ID
            <select
              onChange={(event) =>
                update({
                  model: event.target.value,
                  modelCapabilities: modelCapabilities(
                    models.find((model) => model.id === event.target.value),
                  ),
                })
              }
              required
              value={draft.model}
            >
              {!models.some((model) => model.id === draft.model) && draft.model && (
                <option value={draft.model}>Current model: {draft.model}</option>
              )}
              {models.map((model) => (
                <option
                  className={model.isFree ? 'free-model-option' : undefined}
                  key={model.id}
                  value={model.id}
                >
                  {model.isFree ? '[ FREE ] ' : ''}
                  {model.name === model.id ? model.id : `${model.name} (${model.id})`}
                </option>
              ))}
            </select>
            {modelStatus === 'loading' && (
              <span className="field-hint" role="status">Loading available models…</span>
            )}
            {modelStatus === 'error' && (
              <span className="field-hint" role="status">{modelError}</span>
            )}
            {modelStatus === 'loaded' && models.length === 0 && (
              <span className="field-hint" role="status">No models are available.</span>
            )}
          </label>
        </div>

        <label className="modal-field">
          Knowledge
          <textarea
            maxLength={1_200}
            onChange={(event) => update({ knowledge: event.target.value })}
            placeholder="Domain knowledge, context, frameworks, or subject matter this agent brings"
            rows={3}
            value={draft.knowledge}
          />
          <span className="field-hint">Up to 1,200 characters</span>
        </label>
        <label className="modal-field">
          Skills
          <textarea
            maxLength={1_200}
            onChange={(event) => update({ skills: event.target.value })}
            placeholder="What this agent is good at: analysis, forecasting, legal review…"
            rows={3}
            value={draft.skills}
          />
          <span className="field-hint">Up to 1,200 characters</span>
        </label>
        <label className="modal-field">
          Additional instructions
          <textarea
            maxLength={2_000}
            onChange={(event) => update({ instructions: event.target.value })}
            placeholder="Tone, priorities, and how this agent should contribute"
            rows={3}
            value={draft.instructions}
          />
        </label>

        <div className="modal-actions">
          {agent && (
            <button
              className="text-button delete-button"
              onClick={() => onDelete(agent.id)}
              type="button"
            >
              Delete advisor
            </button>
          )}
          <div className="modal-actions-end">
            <button className="secondary-button" onClick={onClose} type="button">
              Cancel
            </button>
            <button className="primary-button" type="submit">
              Save advisor
            </button>
          </div>
        </div>
      </form>
    </Modal>
  )
}

export default AgentEditorModal
