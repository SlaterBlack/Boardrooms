import { useEffect, useState, type FormEvent } from 'react'
import type { AgentConfig, Provider, ProviderModel } from '../../shared/boardroom'
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
    (value.isFree === undefined || typeof value.isFree === 'boolean')
  )
}

function AgentEditorModal({ agent, onClose, onSave, onDelete }: AgentEditorModalProps) {
  const [draft, setDraft] = useState<AgentConfig>(() =>
    agent ?? {
      id: createId(),
      name: '',
      role: '',
      provider: 'openai',
      model: defaultModel('openai'),
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
                  event.target.value === 'anthropic'
                    ? 'anthropic'
                    : event.target.value === 'openrouter'
                      ? 'openrouter'
                      : 'openai'
                update({ provider, model: defaultModel(provider) })
              }}
              value={draft.provider}
            >
              <option value="openai">OpenAI</option>
              <option value="anthropic">Anthropic</option>
              <option value="openrouter">OpenRouter</option>
            </select>
          </label>
          <label className="modal-field">
            Model ID
            <select
              onChange={(event) => update({ model: event.target.value })}
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
