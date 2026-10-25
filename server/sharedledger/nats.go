package sharedledger

import (
	"context"
	"encoding/json"
	"errors"
	"os"
	"sort"
	"strconv"
	"strings"
	"time"

	"github.com/nats-io/nats.go"
	"github.com/nats-io/nats.go/jetstream"
)

// NATS is the Phase 2 ledger adapter: a JetStream KV bucket holds current task
// state and a stream holds every transition. KV revisions are the CAS; the
// interface is identical to Memory, so the board and jobs do not care which one
// is wired.
type NATS struct {
	conn   *nats.Conn
	js     jetstream.JetStream
	kv     jetstream.KeyValue
	stream string
}

func NewNATS(url, bucket, stream string) (*NATS, error) {
	urls := normalizeNATSURLs(url)
	if len(urls) == 0 {
		return nil, errors.New("sharedledger: nats url is required")
	}
	if bucket == "" {
		bucket = "herdr-tasks"
	}
	if stream == "" {
		stream = "herdr-task-events"
	}
	replicas := len(urls)
	if raw := strings.TrimSpace(os.Getenv("HERDR_WEB_NATS_REPLICAS")); raw != "" {
		if parsed, err := strconv.Atoi(raw); err == nil && parsed > 0 {
			replicas = parsed
		}
	}
	if replicas > 3 {
		replicas = 3
	}
	options := []nats.Option{
		nats.Name("herdr-web-sharedledger"),
		nats.Timeout(5 * time.Second),
		// A console outlives a NATS restart or a losing cluster member. The
		// client reconnects to any URL in the list; the ledger operations are
		// idempotent through KV revisions.
		nats.MaxReconnects(-1),
		nats.ReconnectWait(time.Second),
		nats.ReconnectJitter(500*time.Millisecond, 2*time.Second),
		nats.DrainTimeout(5 * time.Second),
	}
	if token := strings.TrimSpace(os.Getenv("HERDR_WEB_NATS_TOKEN")); token != "" {
		options = append(options, nats.Token(token))
	} else if user := strings.TrimSpace(os.Getenv("HERDR_WEB_NATS_USER")); user != "" {
		options = append(options, nats.UserInfo(user, os.Getenv("HERDR_WEB_NATS_PASSWORD")))
	}
	conn, err := nats.Connect(strings.Join(urls, ","), options...)
	if err != nil {
		return nil, err
	}
	js, err := jetstream.New(conn)
	if err != nil {
		conn.Close()
		return nil, err
	}
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	if _, err := js.Stream(ctx, stream); err != nil {
		if _, err := js.CreateStream(ctx, jetstream.StreamConfig{
			Name:      stream,
			Subjects:  []string{"task.>"},
			Retention: jetstream.LimitsPolicy,
			Storage:   jetstream.FileStorage,
			MaxAge:    30 * 24 * time.Hour,
			Replicas:  replicas,
		}); err != nil {
			conn.Close()
			return nil, err
		}
	}
	kv, err := js.KeyValue(ctx, bucket)
	if err != nil {
		kv, err = js.CreateKeyValue(ctx, jetstream.KeyValueConfig{Bucket: bucket, History: 10, Replicas: replicas})
		if err != nil {
			conn.Close()
			return nil, err
		}
	}
	return &NATS{conn: conn, js: js, kv: kv, stream: stream}, nil
}

func (n *NATS) Close() {
	if n != nil && n.conn != nil {
		n.conn.Close()
	}
}

func (n *NATS) Create(ctx context.Context, task Task) (Task, error) {
	if task.ID == "" {
		return Task{}, ErrInvalidTask
	}
	now := time.Now()
	task.State = Proposed
	task.Version = 1
	task.Owner = ""
	task.Role = ""
	task.LeaseUntil = time.Time{}
	task.Attempts = 0
	task.CreatedAt = now
	task.UpdatedAt = now
	data, err := json.Marshal(task)
	if err != nil {
		return Task{}, err
	}
	if _, err := n.kv.Create(ctx, task.ID, data); err != nil {
		if errors.Is(err, nats.ErrKeyExists) {
			return Task{}, ErrConflict
		}
		return Task{}, err
	}
	n.publish(ctx, task, "created", "", "")
	return cloneTask(task), nil
}

func (n *NATS) Get(ctx context.Context, id string) (Task, error) {
	task, entry, err := n.getRaw(ctx, id)
	if err != nil {
		return Task{}, err
	}
	task, err = n.expire(ctx, task, entry)
	if err != nil {
		return Task{}, err
	}
	return cloneTask(task), nil
}

func (n *NATS) List(ctx context.Context, filter Filter) ([]Task, error) {
	keys, err := n.kv.Keys(ctx)
	if err != nil {
		if errors.Is(err, nats.ErrNoKeysFound) {
			return []Task{}, nil
		}
		return nil, err
	}
	out := make([]Task, 0, len(keys))
	for _, key := range keys {
		task, err := n.Get(ctx, key)
		if err != nil {
			if errors.Is(err, ErrNotFound) {
				continue
			}
			return nil, err
		}
		if filter.State != "" && task.State != filter.State {
			continue
		}
		if filter.Role != "" && task.Role != filter.Role {
			continue
		}
		if filter.Node != "" && task.Owner != filter.Node {
			continue
		}
		out = append(out, task)
	}
	sort.SliceStable(out, func(left, right int) bool {
		if out[left].CreatedAt.Equal(out[right].CreatedAt) {
			return out[left].ID < out[right].ID
		}
		return out[left].CreatedAt.Before(out[right].CreatedAt)
	})
	if filter.Limit > 0 && len(out) > filter.Limit {
		out = out[:filter.Limit]
	}
	return out, nil
}

func (n *NATS) Claim(ctx context.Context, id string, role Role, node string, lease time.Duration, expectedVersion uint64) (Task, error) {
	task, entry, err := n.getRaw(ctx, id)
	if err != nil {
		return Task{}, err
	}
	task, err = n.expire(ctx, task, entry)
	if err != nil {
		return Task{}, err
	}
	// The expiry may have updated the KV; re-read so the revision and version
	// belong to the same value.
	task, entry, err = n.getRaw(ctx, id)
	if err != nil {
		return Task{}, err
	}
	if task.Version != expectedVersion {
		return Task{}, ErrConflict
	}
	if err := claimAllowed(task, role, node); err != nil {
		return Task{}, err
	}
	if role == RoleMerge {
		queued, err := n.List(ctx, Filter{State: MergeQueued})
		if err != nil {
			return Task{}, err
		}
		for _, other := range queued {
			if other.ID != id && mergeRepo(other) == mergeRepo(task) {
				return Task{}, ErrMergeBusy
			}
		}
	}
	if lease <= 0 {
		lease = 30 * time.Minute
	}
	now := time.Now()
	task.State = claimTarget(role)
	task.Role = role
	task.Owner = node
	task.LeaseUntil = now.Add(lease)
	task.Version++
	task.Attempts++
	task.UpdatedAt = now
	if err := n.update(ctx, task, entry); err != nil {
		return Task{}, err
	}
	n.publish(ctx, task, "claimed", node, "")
	return cloneTask(task), nil
}

func (n *NATS) Heartbeat(ctx context.Context, id string, role Role, node string, lease time.Duration) (Task, error) {
	task, entry, err := n.getRaw(ctx, id)
	if err != nil {
		return Task{}, err
	}
	task, err = n.expire(ctx, task, entry)
	if err != nil {
		return Task{}, err
	}
	if !isClaimed(task.State) || task.Role != role || task.Owner != node {
		return Task{}, ErrNotOwner
	}
	task, entry, err = n.getRaw(ctx, id)
	if err != nil {
		return Task{}, err
	}
	if lease <= 0 {
		lease = 30 * time.Minute
	}
	now := time.Now()
	task.LeaseUntil = now.Add(lease)
	task.Version++
	task.UpdatedAt = now
	if err := n.update(ctx, task, entry); err != nil {
		return Task{}, err
	}
	n.publish(ctx, task, "heartbeat", node, "")
	return cloneTask(task), nil
}

func (n *NATS) Attest(ctx context.Context, id string, role Role, node, commit, digest, signature string, expectedVersion uint64) (Task, error) {
	task, entry, err := n.getRaw(ctx, id)
	if err != nil {
		return Task{}, err
	}
	task, err = n.expire(ctx, task, entry)
	if err != nil {
		return Task{}, err
	}
	task, entry, err = n.getRaw(ctx, id)
	if err != nil {
		return Task{}, err
	}
	if task.Version != expectedVersion {
		return Task{}, ErrConflict
	}
	if signature == "" || !VerifyAttestation(id, role, node, commit, digest, signature) {
		return Task{}, ErrSignature
	}
	if !isClaimed(task.State) || task.Role != role || task.Owner != node {
		return Task{}, ErrNotOwner
	}
	if role != RoleDev && role != RoleMerge && !independent(task, node) {
		return Task{}, ErrIndependentNode
	}
	next, ok := attestTarget(role)
	if !ok {
		return Task{}, ErrInvalidState
	}
	now := time.Now()
	task.Attestations = append(task.Attestations, Attestation{
		Role: role, Node: node, Commit: commit, Digest: digest, Signature: signature, At: now,
	})
	if commit != "" {
		task.Artifacts.Commit = commit
	}
	if digest != "" && role == RoleTest {
		task.Artifacts.Tests = digest
	}
	task.State = next
	task.Owner = ""
	task.Role = ""
	task.LeaseUntil = time.Time{}
	task.Version++
	task.UpdatedAt = now
	if err := n.update(ctx, task, entry); err != nil {
		return Task{}, err
	}
	n.publish(ctx, task, "attested", node, "")
	return cloneTask(task), nil
}

func (n *NATS) LinkPR(ctx context.Context, id string, number int) (Task, error) {
	task, entry, err := n.getRaw(ctx, id)
	if err != nil {
		return Task{}, err
	}
	if number <= 0 {
		return Task{}, ErrInvalidState
	}
	task.PR = number
	task.Version++
	task.UpdatedAt = time.Now()
	if err := n.update(ctx, task, entry); err != nil {
		return Task{}, err
	}
	n.publish(ctx, task, "linked", "", "")
	return cloneTask(task), nil
}

func (n *NATS) MarkMerged(ctx context.Context, id, commit string) (Task, error) {
	task, entry, err := n.getRaw(ctx, id)
	if err != nil {
		return Task{}, err
	}
	task.State = Merged
	task.Owner = ""
	task.Role = ""
	task.LeaseUntil = time.Time{}
	if commit != "" {
		task.Artifacts.Commit = commit
	}
	task.Version++
	task.UpdatedAt = time.Now()
	if err := n.update(ctx, task, entry); err != nil {
		return Task{}, err
	}
	n.publish(ctx, task, "merged", "", "")
	return cloneTask(task), nil
}

func (n *NATS) Release(ctx context.Context, id string, role Role, node, reason string) (Task, error) {
	task, entry, err := n.getRaw(ctx, id)
	if err != nil {
		return Task{}, err
	}
	task, err = n.expire(ctx, task, entry)
	if err != nil {
		return Task{}, err
	}
	task, entry, err = n.getRaw(ctx, id)
	if err != nil {
		return Task{}, err
	}
	if !isClaimed(task.State) || task.Role != role || task.Owner != node {
		return Task{}, ErrNotOwner
	}
	task.State = Proposed
	task.Owner = ""
	task.Role = ""
	task.LeaseUntil = time.Time{}
	task.Version++
	task.UpdatedAt = time.Now()
	if err := n.update(ctx, task, entry); err != nil {
		return Task{}, err
	}
	n.publish(ctx, task, "released", node, reason)
	return cloneTask(task), nil
}

func (n *NATS) FailMerge(ctx context.Context, id, node, reason string) (Task, error) {
	task, entry, err := n.getRaw(ctx, id)
	if err != nil {
		return Task{}, err
	}
	task, err = n.expire(ctx, task, entry)
	if err != nil {
		return Task{}, err
	}
	task, entry, err = n.getRaw(ctx, id)
	if err != nil {
		return Task{}, err
	}
	if !isClaimed(task.State) || task.State != MergeQueued || task.Role != RoleMerge || task.Owner != node {
		return Task{}, ErrNotOwner
	}
	task.MergeAttempts++
	task.Owner = ""
	task.Role = ""
	task.LeaseUntil = time.Time{}
	if task.MergeAttempts >= MaxMergeAttempts {
		task.State = MergeBlocked
	} else {
		task.State = AuditApproved
	}
	task.Version++
	task.UpdatedAt = time.Now()
	if err := n.update(ctx, task, entry); err != nil {
		return Task{}, err
	}
	n.publish(ctx, task, "merge_failed", node, reason)
	return cloneTask(task), nil
}

func (n *NATS) Cancel(ctx context.Context, id string, node, reason string) (Task, error) {
	task, entry, err := n.getRaw(ctx, id)
	if err != nil {
		return Task{}, err
	}
	if task.State == Cancelled || task.State == Merged {
		return Task{}, ErrInvalidState
	}
	task.State = Cancelled
	task.Owner = ""
	task.Role = ""
	task.LeaseUntil = time.Time{}
	task.Version++
	task.UpdatedAt = time.Now()
	if err := n.update(ctx, task, entry); err != nil {
		return Task{}, err
	}
	n.publish(ctx, task, "cancelled", node, reason)
	return cloneTask(task), nil
}

func (n *NATS) Events(ctx context.Context, id string) ([]Event, error) {
	if _, err := n.Get(ctx, id); err != nil {
		return nil, err
	}
	consumer, err := n.js.OrderedConsumer(ctx, n.stream, jetstream.OrderedConsumerConfig{
		FilterSubjects: []string{"task." + id + ".>"},
		DeliverPolicy:  jetstream.DeliverAllPolicy,
	})
	if err != nil {
		return nil, err
	}
	messages, err := consumer.Messages()
	if err != nil {
		return nil, err
	}
	defer messages.Stop()
	events := []Event{}
	for {
		message, err := messages.Next(jetstream.NextMaxWait(100 * time.Millisecond))
		if err != nil {
			if errors.Is(err, nats.ErrTimeout) || errors.Is(err, jetstream.ErrMsgIteratorClosed) {
				break
			}
			return nil, err
		}
		var event Event
		if err := json.Unmarshal(message.Data(), &event); err != nil {
			return nil, err
		}
		events = append(events, event)
	}
	return events, nil
}

func (n *NATS) getRaw(ctx context.Context, id string) (Task, jetstream.KeyValueEntry, error) {
	entry, err := n.kv.Get(ctx, id)
	if err != nil {
		if errors.Is(err, nats.ErrKeyNotFound) {
			return Task{}, nil, ErrNotFound
		}
		return Task{}, nil, err
	}
	var task Task
	if err := json.Unmarshal(entry.Value(), &task); err != nil {
		return Task{}, nil, err
	}
	return task, entry, nil
}

func (n *NATS) update(ctx context.Context, task Task, entry jetstream.KeyValueEntry) error {
	data, err := json.Marshal(task)
	if err != nil {
		return err
	}
	if _, err := n.kv.Update(ctx, task.ID, data, entry.Revision()); err != nil {
		if errors.Is(err, nats.ErrKeyExists) || errors.Is(err, nats.ErrKeyNotFound) ||
			strings.Contains(err.Error(), "wrong last sequence") || strings.Contains(err.Error(), "revision mismatch") {
			return ErrConflict
		}
		return err
	}
	return nil
}

func (n *NATS) expire(ctx context.Context, task Task, entry jetstream.KeyValueEntry) (Task, error) {
	if !isClaimed(task.State) || task.LeaseUntil.IsZero() || time.Now().Before(task.LeaseUntil) {
		return task, nil
	}
	task.State = Proposed
	task.Owner = ""
	task.Role = ""
	task.LeaseUntil = time.Time{}
	task.Attempts++
	task.Version++
	task.UpdatedAt = time.Now()
	if err := n.update(ctx, task, entry); err != nil {
		return Task{}, err
	}
	n.publish(ctx, task, "expired", "", "lease expired")
	return task, nil
}

func (n *NATS) publish(ctx context.Context, task Task, kind, node, reason string) {
	event := Event{
		TaskID: task.ID, Type: kind, State: task.State, Role: task.Role,
		Node: node, Version: task.Version, Reason: reason, At: task.UpdatedAt,
	}
	data, err := json.Marshal(event)
	if err != nil {
		return
	}
	_, _ = n.js.Publish(ctx, "task."+task.ID+"."+kind, data)
}

// normalizeNATSURLs accepts a comma- or whitespace-separated cluster list. A
// single URL stays a single URL; an empty entry is ignored rather than becoming
// an empty nats:// target.
func normalizeNATSURLs(raw string) []string {
	fields := strings.FieldsFunc(raw, func(r rune) bool {
		return r == ',' || r == ' ' || r == '\n' || r == '\t'
	})
	urls := make([]string, 0, len(fields))
	for _, field := range fields {
		field = strings.TrimSpace(field)
		if field == "" {
			continue
		}
		if !strings.Contains(field, "://") {
			field = "nats://" + field
		}
		urls = append(urls, field)
	}
	return urls
}
