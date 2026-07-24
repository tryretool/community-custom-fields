# frozen_string_literal: true

class AddTriggerAndDurationToTopicStatusChanges < ActiveRecord::Migration[7.2]
  def up
    add_column :community_custom_fields_topic_status_changes, :user_id, :integer
    add_column :community_custom_fields_topic_status_changes, :post_id, :integer
    add_column :community_custom_fields_topic_status_changes, :duration, :bigint

    # Backfill existing rows: seconds spent in the status being left, measured
    # from the prior change for the topic (or the topic's creation).
    execute <<~SQL
      UPDATE community_custom_fields_topic_status_changes sc
      SET duration = GREATEST(
        TRUNC(
          EXTRACT(EPOCH FROM (sc.created_at - COALESCE(prev.prev_created_at, t.created_at, sc.created_at)))
        )::bigint,
        0
      )
      FROM (
        SELECT id, topic_id,
               LAG(created_at) OVER (PARTITION BY topic_id ORDER BY id) AS prev_created_at
        FROM community_custom_fields_topic_status_changes
      ) prev
      LEFT JOIN topics t ON t.id = prev.topic_id
      WHERE sc.id = prev.id;
    SQL

    change_column_null :community_custom_fields_topic_status_changes, :duration, false
  end

  def down
    remove_column :community_custom_fields_topic_status_changes, :duration
    remove_column :community_custom_fields_topic_status_changes, :post_id
    remove_column :community_custom_fields_topic_status_changes, :user_id
  end
end
