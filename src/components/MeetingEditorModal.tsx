import { useMemo, useState, type FormEvent } from 'react'
import type { AgentConfig, ChatAgentRole, ChatType, Meeting } from '../../shared/boardroom'
import {
  isDecisionRoutingAgent,
  isTextGenerationAgent,
  modelCapabilityLabels,
} from '../../shared/chat'
import Modal from './Modal'

export interface NewMeetingDetails {
  name: string
  task: string
  chatType: ChatType
  agents: AgentConfig[]
  agentRoles: Record<string, ChatAgentRole>
  facilitatorId: string
}

interface MeetingEditorModalProps {
  agents: AgentConfig[]
  meeting?: Meeting
  onClose: () => void
  onSave: (details: NewMeetingDetails) => void
}

function providerLabel(provider: AgentConfig['provider']): string {
  switch (provider) {
    case 'openai':
      return 'OpenAI'
    case 'anthropic':
      return 'Anthropic'
    case 'gemini':
      return 'Gemini'
    case 'openrouter':
      return 'OpenRouter'
    case 'magnific':
      return 'Magnific'
  }
}

function MeetingEditorModal({ agents, meeting, onClose, onSave }: MeetingEditorModalProps) {
  const availableAgents = useMemo(() => {
    const agentsById = new Map(agents.map((agent) => [agent.id, agent]))
    meeting?.agents.forEach((agent) => {
      if (!agentsById.has(agent.id)) agentsById.set(agent.id, agent)
    })
    return [...agentsById.values()]
  }, [agents, meeting])
  const [name, setName] = useState(meeting?.name ?? '')
  const [task, setTask] = useState(meeting?.task ?? '')
  const [chatType, setChatType] = useState<ChatType>(meeting?.chatType ?? 'informational')
  const [selectedIds, setSelectedIds] = useState(() =>
    meeting?.agents.map((agent) => agent.id) ??
    agents.slice(0, 5).map((agent) => agent.id),
  )
  const [orchestratorId, setOrchestratorId] = useState(
    () =>
      meeting?.agents.find((agent) => meeting?.agentRoles[agent.id] === 'director')?.id ??
      availableAgents.find(
        (agent) => agent.provider !== 'magnific' || isDecisionRoutingAgent(agent),
      )?.id ??
      '',
  )
  const [selectionError, setSelectionError] = useState('')
  const selectedAgents = useMemo(
    () => availableAgents.filter((agent) => selectedIds.includes(agent.id)),
    [availableAgents, selectedIds],
  )
  const orchestratorOptions = selectedAgents.filter(
    (agent) => agent.provider !== 'magnific' || isDecisionRoutingAgent(agent),
  )
  const activeOrchestratorId = orchestratorOptions.some(
    (agent) => agent.id === orchestratorId,
  )
    ? orchestratorId
    : orchestratorOptions[0]?.id ?? ''
  const fallbackAgentId =
    selectedAgents.find(
      (agent) =>
        agent.id !== activeOrchestratorId && isTextGenerationAgent(agent),
    )?.id ??
    selectedAgents[0]?.id ??
    ''
  const hasTextContributor = selectedAgents.some(
    (agent) => agent.id !== activeOrchestratorId && isTextGenerationAgent(agent),
  )
  const canSave =
    name.trim().length > 0 &&
    selectedAgents.length >= 2 &&
    Boolean(activeOrchestratorId) &&
    hasTextContributor

  function toggleAgent(id: string) {
    if (selectedIds.includes(id)) {
      setSelectedIds(selectedIds.filter((selectedId) => selectedId !== id))
      setSelectionError('')
      return
    }
    if (selectedIds.length >= 5) {
      setSelectionError('A chat can include up to five agents.')
      return
    }
    setSelectedIds([...selectedIds, id])
    setSelectionError('')
  }

  function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (!name.trim() || selectedAgents.length < 2 || !activeOrchestratorId) {
      return
    }
    onSave({
      name: name.trim(),
      task: task.trim(),
      chatType,
      agents: selectedAgents,
      agentRoles: Object.fromEntries(
        selectedAgents.map((agent) => [
          agent.id,
          agent.id === activeOrchestratorId ? 'director' : 'advisor',
        ]),
      ),
      facilitatorId: fallbackAgentId,
    })
  }

  return (
    <Modal title={meeting ? 'Edit boardroom' : 'Create a boardroom'} onClose={onClose}>
      <form className="modal-form" onSubmit={save}>
        <label className="modal-field">
          Chat name
          <input
            autoFocus
            maxLength={120}
            onChange={(event) => setName(event.target.value)}
            placeholder="e.g. Product launch review"
            required
            value={name}
          />
        </label>
        <label className="modal-field">
          Chat type
          <select
            onChange={(event) =>
              setChatType(event.target.value === 'document' ? 'document' : 'informational')
            }
            value={chatType}
          >
            <option value="informational">Informational chat</option>
            <option value="document">Report/document building</option>
          </select>
        </label>
        <p className="field-hint">
          {chatType === 'informational'
            ? 'The Orchestrator routes each message to agents based on their capabilities. Start with @{agent name} to address one agent directly.'
            : 'Build a document through agent contributions, then preview and export it as a PDF.'}
        </p>
        <label className="modal-field">
          {chatType === 'document'
            ? 'Document brief (optional)'
            : 'Boardroom context (optional)'}
          <textarea
            maxLength={8_000}
            onChange={(event) => setTask(event.target.value)}
            placeholder={
              chatType === 'document'
                ? 'Describe the job or document you want the board to build.'
                : 'Add background to help advisors understand this boardroom.'
            }
            rows={4}
            value={task}
          />
        </label>

        <fieldset className="participant-picker">
          <legend>Choose boardroom agents (up to five)</legend>
          {availableAgents.length === 0 ? (
            <p className="empty-picker">
              There are no agents yet. Add an agent from the Agents tab first.
            </p>
          ) : (
            <div className="participant-list">
              {availableAgents.map((agent) => {
                const selected = selectedIds.includes(agent.id)
                return (
                  <div className="participant-option" key={agent.id}>
                    <label className="participant-choice">
                      <input
                        checked={selected}
                        onChange={() => toggleAgent(agent.id)}
                        type="checkbox"
                      />
                      <span className="participant-initial">
                        {agent.name.trim().charAt(0).toUpperCase() || 'A'}
                      </span>
                      <span className="participant-description">
                        <strong>{agent.name || 'Unnamed agent'}</strong>
                        <span>{agent.role} · {providerLabel(agent.provider)}</span>
                        {selected && (
                          <span aria-label="Model capabilities" className="model-capability-list">
                            {modelCapabilityLabels(agent.modelCapabilities).length > 0
                              ? modelCapabilityLabels(agent.modelCapabilities).map((capability) => (
                                  <span key={capability}>{capability}</span>
                                ))
                              : <span>Text only</span>}
                          </span>
                        )}
                      </span>
                    </label>
                  </div>
                )
              })}
            </div>
          )}
        </fieldset>
        {selectionError && <p className="form-error" role="alert">{selectionError}</p>}
        {selectedAgents.length < 2 && (
          <p className="form-error" role="alert">
            Select at least two agents: one Orchestrator and one agent to answer.
          </p>
        )}
        {selectedAgents.length >= 2 && !hasTextContributor && (
          <p className="form-error" role="alert">
            Select at least one text-capable agent besides the Orchestrator to answer chat messages.
          </p>
        )}
        {orchestratorOptions.length > 0 && (
          <label className="modal-field">
            Orchestrator
            <select
              onChange={(event) => setOrchestratorId(event.target.value)}
              value={activeOrchestratorId}
            >
              {orchestratorOptions.map((agent) => (
                <option key={agent.id} value={agent.id}>{agent.name}</option>
              ))}
            </select>
            <span className="field-hint">
              {selectedAgents.some(
                (agent) =>
                  agent.id === activeOrchestratorId &&
                  isDecisionRoutingAgent(agent),
              )
                ? 'Gemini Decision 1 uses OpenRouter’s structured Decisions API to select agents; it does not write chat replies.'
                : 'The Orchestrator routes each request to agents based on their model capabilities.'}
            </span>
          </label>
        )}
        {orchestratorOptions.length === 0 && selectedAgents.length > 0 && (
          <p className="form-error" role="alert">
            Select a non-Magnific agent to act as the Orchestrator.
          </p>
        )}
        {selectedAgents.some(
          (agent) => agent.modelCapabilities?.supportsImageProcessing === true,
        ) && (
          <p className="field-hint">
            Image processing is available from capable services such as Magnific; no fixed role assignment is needed.
          </p>
        )}

        <p className="field-hint">
          Saving agent edits updates their settings in existing boardrooms.
        </p>
        <div className="modal-actions">
          <span className="meeting-selection-count">
            {selectedAgents.length} {selectedAgents.length === 1 ? 'agent' : 'agents'} selected
          </span>
          <div className="modal-actions-end">
            <button className="secondary-button" onClick={onClose} type="button">
              Cancel
            </button>
            <button
              className="primary-button"
              disabled={!canSave}
              type="submit"
            >
              {meeting ? 'Save changes' : 'Create boardroom'}
            </button>
          </div>
        </div>
      </form>
    </Modal>
  )
}

export default MeetingEditorModal
