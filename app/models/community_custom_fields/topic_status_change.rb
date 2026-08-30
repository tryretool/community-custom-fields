# frozen_string_literal: true

module CommunityCustomFields
  class TopicStatusChange < ActiveRecord::Base
    self.table_name = "community_custom_fields_topic_status_changes"

    belongs_to :topic, class_name: "::Topic"
    belongs_to :assignee, class_name: "::User", optional: true
    belongs_to :user, class_name: "::User", optional: true
    belongs_to :post, class_name: "::Post", optional: true

    def self.record(
      topic:,
      from_status:,
      source:,
      assignee_id:,
      user_id: nil,
      post_id: nil,
      previous_status_at: nil
    )
      to_status = topic.custom_fields["status"]
      return if to_status.blank? || to_status == from_status

      last_change = where(topic_id: topic.id).order(:id).last
      started_at = last_change&.created_at || previous_status_at || topic.created_at
      duration = (Time.current - started_at).to_i

      create!(
        topic_id: topic.id,
        from_status: from_status,
        to_status: to_status,
        source: source,
        assignee_id: assignee_id,
        user_id: user_id,
        post_id: post_id,
        duration: duration,
      )
    end
  end
end

# == Schema Information
#
# Table name: community_custom_fields_topic_status_changes
#
#  id          :bigint           not null, primary key
#  duration    :bigint           not null
#  from_status :string
#  source      :string           not null
#  to_status   :string           not null
#  created_at  :datetime         not null
#  assignee_id :integer
#  post_id     :integer
#  topic_id    :integer          not null
#  user_id     :integer
#
# Indexes
#
#  idx_on_assignee_id_bc22060231                                   (assignee_id)
#  index_community_custom_fields_topic_status_changes_on_topic_id  (topic_id)
#
