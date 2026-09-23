# frozen_string_literal: true

class CreateTopicStatusChanges < ActiveRecord::Migration[7.2]
  def change
    create_table :community_custom_fields_topic_status_changes do |t|
      t.integer :topic_id, null: false
      t.integer :assignee_id
      t.string :from_status
      t.string :to_status, null: false
      t.string :source, null: false
      t.datetime :created_at, null: false
    end

    add_index :community_custom_fields_topic_status_changes, :topic_id
    add_index :community_custom_fields_topic_status_changes, :assignee_id
  end
end
