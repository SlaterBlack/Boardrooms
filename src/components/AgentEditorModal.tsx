import { useState, type FormEvent } from 'react'
import type { AgentConfig, Provider } from '../../shared/boardroom'
import Modal from './Modal'

interface AgentEditorModalProps {
  agent: AgentConfig | null
  onClose: () => void
  onSave: (agent: AgentConfig) => void
  onDelete: (agentId: string) => void
}

function defaultModel(provider: Provider): string {
  return provider === 'openai' ? 'gpt-6.2-sol' : 'claude-sonnet-5-5'
}

function AgentEditorModal({ agent, onClose, onSave, onDelete }: AgentEditorModalProps) {
  const [draft, setDraft] = useState<AgentConfig>(() =>
    agent ?? {
      id: crypto.randomUUID(),
      name: '',
      role: '',
      provider: 'openai',
      model: defaultModel('openai'),
      knowledge: '',
      skills: '',
      instructions: '',
    },
  )

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
                  event.target.value === 'anthropic' ? 'anthropic' : 'openai'
                update({ provider, model: defaultModel(provider) })
              }}
              value={draft.provider}
            >
              <option value="openai">OpenAI</option>
              <option value="anthropic">Anthropic</option>
            </select>
          </label>
          <label className="modal-field">
            Model ID
            <input
              maxLength={120}
              onChange={(event) => update({ model: event.target.value })}
              placeholder="Provider model ID"
              required
              value={draft.model}
            />
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
