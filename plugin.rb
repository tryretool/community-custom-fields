# frozen_string_literal: true

# name: community-custom-fields
# about: Adds custom fields for using Discourse as a support platform
# url: https://github.com/tryretool/community-custom-fields
# version: 0.1
# authors: Retool

enabled_site_setting :community_custom_fields_enabled

module ::CommunityCustomFields
  PLUGIN_NAME = "community-custom-fields"
  CUSTOM_FIELDS = {
    assignee_id: :integer,
    first_assigned_to_id: :integer,
    first_assigned_at: :datetime, 
    last_assigned_to_id: :integer,
    last_assigned_at: :datetime,
    account_name: :string,
    is_committed: :boolean,
    is_agency: :boolean,
    priority: :string,
    product_area: :string,
    status: :string,
    outcome: :string,
    closed_at: :datetime,
    snoozed_until: :datetime,
    waiting_since: :datetime,
    waiting_id: :integer
  }
end

require_relative 'lib/community_custom_fields/engine.rb'

after_initialize do
  CommunityCustomFields::CUSTOM_FIELDS.each do |name, type|
    Topic.register_custom_field_type(name, type)
  end

  TopicList.preloaded_custom_fields.merge(CommunityCustomFields::CUSTOM_FIELDS.keys)
  
  add_to_serializer(:topic_view, :custom_fields) do
    object.topic.custom_fields.slice(*CommunityCustomFields::CUSTOM_FIELDS.keys)
  end

  on(:topic_created) do |topic, _opts, user|
    next unless topic.archetype == "regular"
    next if user.id <= 0

    topic.custom_fields[:status] = "new"

    if !user.admin
      topic.custom_fields[:waiting_since] = Time.current.iso8601
      topic.custom_fields[:waiting_id] = user.id
    end

    topic.save_custom_fields
  end

  on(:post_created) do |post, _opts, user|
    next unless post.archetype == "regular"
    next if user.id <= 0
    next unless post.post_type == 1 || post.post_type == 4
    next if post.post_number == 1
    
    topic = post.topic
    topic.custom_fields[:status] ||= "new"

    if user.admin && post.post_type == 1
      topic.custom_fields[:waiting_since] = nil
      topic.custom_fields[:waiting_id] = nil
    elsif user.admin && post.post_type == 4
      if topic.custom_fields[:status] == "snoozed"
        topic.custom_fields[:status] = "open"
        topic.custom_fields[:snoozed_until] = nil
      end

      if topic.custom_fields[:status] == "closed"
        # this handles an edge case where `closed_at` was never set
        topic.custom_fields[:closed_at] ||= Time.current.iso8601

        if topic.custom_fields[:last_assigned_to_id].nil?
          topic.custom_fields[:status] = "new"
        else
          topic.custom_fields[:status] = "open"
          topic.custom_fields[:assignee_id] = topic.custom_fields[:last_assigned_to_id]
          topic.custom_fields[:last_assigned_at] = Time.current.iso8601
        end
        
        topic.custom_fields[:outcome] = nil
        topic.custom_fields[:closed_at] = nil
      end
    else 
      if user.id != topic.custom_fields[:waiting_id].to_i
        topic.custom_fields[:waiting_since] = Time.current.iso8601
        topic.custom_fields[:waiting_id] = user.id
      end

      if topic.custom_fields[:status] == "snoozed"
        topic.custom_fields[:status] = "open"
        topic.custom_fields[:snoozed_until] = nil
      end

      if topic.custom_fields[:status] == "closed"
        # this handles an edge case where `closed_at` was never set
        topic.custom_fields[:closed_at] ||= Time.current.iso8601

        if topic.custom_fields[:last_assigned_to_id].nil? || Time.iso8601(topic.custom_fields[:closed_at]) < 1.month.ago.iso8601
          topic.custom_fields[:status] = "new"
        else
          topic.custom_fields[:status] = "open"
          topic.custom_fields[:assignee_id] = topic.custom_fields[:last_assigned_to_id]
          topic.custom_fields[:last_assigned_at] = Time.current.iso8601
        end
        topic.custom_fields[:outcome] = nil
        topic.custom_fields[:closed_at] = nil
      end
    end
    
    topic.save_custom_fields
  end
end
