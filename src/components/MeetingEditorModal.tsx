import { useMemo, useState, type FormEvent } from 'react'
import type { AgentConfig, ChatAgentRole, ChatType, Meeting } from '../../shared/boardroom'
import { CHAT_AGENT_ROLES, isChatAgentRole } from '../../shared/chat'
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
    case 'openrouter':
      return 'OpenRouter'
    case 'magnific':
      return 'Magnific'
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
      return 'Image Processor (Magnific)'
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

function canAssignRole(agent: AgentConfig, role: ChatAgentRole): boolean {
  if (
    agent.provider === 'magnific' &&
    role !== 'image_generator' &&
    role !== 'image_processor'
  ) {
    return false
  }
  if (role === 'image_generator') {
    return agent.modelCapabilities?.supportsImageGeneration === true
  }
  if (role === 'image_processor') {
    return (
      agent.provider === 'magnific' &&
      agent.modelCapabilities?.supportsImageProcessing === true
    )
  }
  if (role === 'image_analyser') {
    return agent.modelCapabilities?.supportsVision === true
  }
  if (role === 'researcher') {
    return agent.modelCapabilities?.supportsWebSearch === true
  }
  return true
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
  const [agentRoles, setAgentRoles] = useState<Record<string, ChatAgentRole>>(() =>
    Object.fromEntries(
      availableAgents.map((agent) => [
        agent.id,
        meeting?.agentRoles[agent.id] ?? agent.defaultChatRole,
      ]),
    ),
  )
  const [selectedIds, setSelectedIds] = useState(() =>
    meeting?.agents.map((agent) => agent.id) ??
    agents.slice(0, 5).map((agent) => agent.id),
  )
  const [facilitatorId, setFacilitatorId] = useState(
    meeting?.facilitatorId ?? availableAgents[0]?.id ?? '',
  )
  const [selectionError, setSelectionError] = useState('')
  const selectedAgents = useMemo(
    () => availableAgents.filter((agent) => selectedIds.includes(agent.id)),
    [availableAgents, selectedIds],
  )
  const advisors = selectedAgents.filter((agent) => agentRoles[agent.id] === 'advisor')
  const orchestrators = selectedAgents.filter(
    (agent) => agentRoles[agent.id] === 'director',
  )
  const duplicateSpecialistRoles = selectedAgents.some(
    (agent, index) =>
      agentRoles[agent.id] !== 'advisor' &&
      selectedAgents.findIndex(
        (candidate) => agentRoles[candidate.id] === agentRoles[agent.id],
      ) !== index,
  )
  const incompatibleRoleAssignments = selectedAgents.some(
    (agent) => !canAssignRole(agent, agentRoles[agent.id]),
  )
  const activeFacilitatorId = advisors.some((agent) => agent.id === facilitatorId)
    ? facilitatorId
    : (advisors[0]?.id ?? '')
  const canSave =
    name.trim().length > 0 &&
    selectedAgents.length > 0 &&
    advisors.length > 0 &&
    orchestrators.length === 1 &&
    !duplicateSpecialistRoles &&
    !incompatibleRoleAssignments

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
    const agent = availableAgents.find((candidate) => candidate.id === id)
    if (agent) {
      setAgentRoles((current) => ({ ...current, [id]: agent.defaultChatRole }))
    }
    setSelectionError('')
  }

  function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (!name.trim() || selectedAgents.length === 0 || advisors.length === 0) {
      return
    }
    onSave({
      name: name.trim(),
      task: task.trim(),
      chatType,
      agents: selectedAgents,
      agentRoles: Object.fromEntries(
        selectedAgents.map((agent) => [agent.id, agentRoles[agent.id] ?? 'advisor']),
      ),
      facilitatorId: activeFacilitatorId,
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
            ? 'Advisors answer directly without a facilitator summary. Start with @{advisor name} to ask one advisor.'
            : 'Build a document through discussion, then preview and export it as a PDF.'}
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
                const assignedRoles = new Set(
                  selectedAgents
                    .filter((selectedAgent) => selectedAgent.id !== agent.id)
                    .map((selectedAgent) => agentRoles[selectedAgent.id]),
                )
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
                      </span>
                    </label>
                    {selected && (
                      <select
                        aria-label={`${agent.name} chat role`}
                        className="participant-role-select"
                        onChange={(event) => {
                          const role = event.target.value
                          if (isChatAgentRole(role)) {
                            setAgentRoles((current) => ({
                              ...current,
                              [agent.id]: role,
                            }))
                          }
                        }}
                        value={agentRoles[agent.id] ?? 'advisor'}
                      >
                        {CHAT_AGENT_ROLES.map((role) => (
                          <option
                            disabled={
                              (role !== 'advisor' && assignedRoles.has(role)) ||
                              !canAssignRole(agent, role)
                            }
                            key={role}
                            value={role}
                          >
                            {chatRoleLabel(role)}
                          </option>
                        ))}
                      </select>
                    )}
                  </div>
                )
              })}
            </div>
          )}
        </fieldset>
        {selectionError && <p className="form-error" role="alert">{selectionError}</p>}
        {selectedAgents.length > 0 && advisors.length === 0 && (
          <p className="form-error" role="alert">
            Assign at least one selected agent the Meeting Member role to answer chat messages.
          </p>
        )}
        {selectedAgents.length > 0 && orchestrators.length !== 1 && (
          <p className="form-error" role="alert">
            Assign exactly one selected agent the Orchestrator role.
          </p>
        )}
        {duplicateSpecialistRoles && (
          <p className="form-error" role="alert">
            Each specialist role can be assigned to only one agent in a boardroom.
          </p>
        )}
        {incompatibleRoleAssignments && (
          <p className="form-error" role="alert">
            A selected role requires a compatible provider and model. Choose a capable model in the agent profile first.
          </p>
        )}
        {selectedAgents.some((agent) => agentRoles[agent.id] === 'director') && (
          <p className="field-hint">
            The Orchestrator routes each message to the smallest effective sequence of up to three agents.
          </p>
        )}
        {selectedAgents.some((agent) => agentRoles[agent.id] === 'image_processor') && (
          <p className="field-hint">
            Image processing uses Magnific and requires MAGNIFIC_API_KEY on the server.
          </p>
        )}
        {selectedAgents.some((agent) => agentRoles[agent.id] === 'image_generator') && (
          <p className="field-hint">
            Image generation requires a model that supports image output, including Magnific Mystic models.
          </p>
        )}
        {selectedAgents.some((agent) => agentRoles[agent.id] === 'image_analyser') && (
          <p className="field-hint">
            Image analysis requires a model that supports image input.
          </p>
        )}
        {selectedAgents.some((agent) => agentRoles[agent.id] === 'report_formatter') && (
          <p className="field-hint">
            The Document Formatter applies its profile’s style instructions to generated reports.
          </p>
        )}
        {selectedAgents.some((agent) => agentRoles[agent.id] === 'researcher') && (
          <p className="field-hint">
            Researcher uses provider-native web search when the assigned model supports it.
          </p>
        )}
        {selectedAgents.some((agent) => agentRoles[agent.id] === 'facilitator') && (
          <p className="field-hint">
            The Facilitator asks concise clarifying questions when the goal or scope is unclear.
          </p>
        )}
        {selectedAgents.some((agent) => agentRoles[agent.id] === 'critic') && (
          <p className="field-hint">
            The Critic identifies risks and weak assumptions, and suggests mitigations.
          </p>
        )}
        {selectedAgents.some((agent) => agentRoles[agent.id] === 'synthesizer') && (
          <p className="field-hint">
            The Synthesizer consolidates contributions without introducing new domain opinions.
          </p>
        )}
        {selectedAgents.some((agent) => agentRoles[agent.id] === 'executor') && (
          <p className="field-hint">
            The Executor turns agreed decisions into concrete, ready-to-use artifacts.
          </p>
        )}

        {chatType === 'document' && (
          <div className="form-grid meeting-options">
            <label className="modal-field">
              Facilitator
              <select
                disabled={selectedAgents.length === 0}
                onChange={(event) => setFacilitatorId(event.target.value)}
                value={activeFacilitatorId}
              >
                {advisors.map((agent) => (
                  <option key={agent.id} value={agent.id}>{agent.name}</option>
                ))}
              </select>
            </label>
          </div>
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
