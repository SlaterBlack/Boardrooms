import { useMemo, useState, type FormEvent } from 'react'
import type { AgentConfig } from '../../shared/boardroom'
import Modal from './Modal'

export interface NewMeetingDetails {
  name: string
  task: string
  agents: AgentConfig[]
  facilitatorId: string
  rounds: number
}

interface MeetingEditorModalProps {
  agents: AgentConfig[]
  onClose: () => void
  onCreate: (details: NewMeetingDetails) => void
}

function MeetingEditorModal({ agents, onClose, onCreate }: MeetingEditorModalProps) {
  const [name, setName] = useState('')
  const [task, setTask] = useState('')
  const [selectedIds, setSelectedIds] = useState(() =>
    agents.slice(0, 5).map((agent) => agent.id),
  )
  const [facilitatorId, setFacilitatorId] = useState(agents[0]?.id ?? '')
  const [rounds, setRounds] = useState(2)
  const [selectionError, setSelectionError] = useState('')
  const selectedAgents = useMemo(
    () => agents.filter((agent) => selectedIds.includes(agent.id)),
    [agents, selectedIds],
  )
  const activeFacilitatorId = selectedAgents.some((agent) => agent.id === facilitatorId)
    ? facilitatorId
    : (selectedAgents[0]?.id ?? '')
  const canCreate = name.trim().length > 0 && task.trim().length > 0 && selectedAgents.length > 0

  function toggleAgent(id: string) {
    if (selectedIds.includes(id)) {
      setSelectedIds(selectedIds.filter((selectedId) => selectedId !== id))
      setSelectionError('')
      return
    }
    if (selectedIds.length >= 5) {
      setSelectionError('A meeting can include up to five agents.')
      return
    }
    setSelectedIds([...selectedIds, id])
    setSelectionError('')
  }

  function create(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (!name.trim() || !task.trim() || selectedAgents.length === 0) return
    onCreate({
      name: name.trim(),
      task: task.trim(),
      agents: selectedAgents,
      facilitatorId: activeFacilitatorId,
      rounds,
    })
  }

  return (
    <Modal title="Create a meeting" onClose={onClose}>
      <form className="modal-form" onSubmit={create}>
        <label className="modal-field">
          Meeting name
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
          Task or agenda
          <textarea
            maxLength={8_000}
            onChange={(event) => setTask(event.target.value)}
            placeholder="What question or decision should the agents discuss?"
            required
            rows={4}
            value={task}
          />
        </label>

        <fieldset className="participant-picker">
          <legend>Choose agents for this meeting (up to five)</legend>
          {agents.length === 0 ? (
            <p className="empty-picker">
              There are no agents yet. Add an agent from the Agents tab first.
            </p>
          ) : (
            <div className="participant-list">
              {agents.map((agent) => (
                <label className="participant-option" key={agent.id}>
                  <input
                    checked={selectedIds.includes(agent.id)}
                    onChange={() => toggleAgent(agent.id)}
                    type="checkbox"
                  />
                  <span className="participant-initial">
                    {agent.name.trim().charAt(0).toUpperCase() || 'A'}
                  </span>
                  <span className="participant-description">
                    <strong>{agent.name || 'Unnamed agent'}</strong>
                    <span>{agent.role} · {agent.provider === 'openai' ? 'OpenAI' : 'Anthropic'}</span>
                  </span>
                </label>
              ))}
            </div>
          )}
        </fieldset>
        {selectionError && <p className="form-error" role="alert">{selectionError}</p>}

        <div className="form-grid meeting-options">
          <label className="modal-field">
            Discussion rounds
            <select onChange={(event) => setRounds(Number(event.target.value))} value={rounds}>
              <option value={1}>1 round</option>
              <option value={2}>2 rounds</option>
              <option value={3}>3 rounds</option>
            </select>
          </label>
          <label className="modal-field">
            Facilitator
            <select
              disabled={selectedAgents.length === 0}
              onChange={(event) => setFacilitatorId(event.target.value)}
              value={activeFacilitatorId}
            >
              {selectedAgents.map((agent) => (
                <option key={agent.id} value={agent.id}>{agent.name}</option>
              ))}
            </select>
          </label>
        </div>
        <p className="field-hint">
          Agent settings are copied into the meeting. Later edits apply to new meetings.
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
              disabled={!canCreate}
              type="submit"
            >
              Create meeting
            </button>
          </div>
        </div>
      </form>
    </Modal>
  )
}

export default MeetingEditorModal
