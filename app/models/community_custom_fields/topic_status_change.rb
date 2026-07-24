# frozen_string_literal: true

module CommunityCustomFields
  class TopicStatusChange < ActiveRecord::Base
    self.table_name = "community_custom_fields_topic_status_changes"

    belongs_to :topic, class_name: "::Topic"
    belongs_to :assignee, class_name: "::User", optional: true

    def self.record(topic:, from_status:, source:, assignee_id:)
      to_status = topic.custom_fields["status"]
      return if to_status.blank? || to_status == from_status

      create!(
        topic_id: topic.id,
        from_status: from_status,
        to_status: to_status,
        source: source,
        assignee_id: assignee_id
      )
    end
  end
end
