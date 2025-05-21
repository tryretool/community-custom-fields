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
    priority: :string,
    product_area: :string,
    status: :string,
    outcome: :string,
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
    next unless topic.archetype == "regular" && user.id > 0

    topic.custom_fields[:assignee_id] = 0
    topic.custom_fields[:status] = "new"
    topic.custom_fields[:waiting_since] = Time.now.utc
    topic.custom_fields[:waiting_id] = user.id
    topic.save_custom_fields
  end

  on(:post_created) do |post, _opts, user|
    next unless post.archetype == "regular" && user.id > 0 && post.post_type == 1

    topic = post.topic

    if user.admin
      topic.custom_fields[:waiting_since] = nil
      topic.custom_fields[:waiting_id] = nil
    else 
      if user.id != topic.custom_fields[:waiting_id]
        topic.custom_fields[:waiting_since] = Time.now.utc
        topic.custom_fields[:waiting_id] = user.id
      end

      if topic.custom_fields[:status] == "snoozed"
        topic.custom_fields[:status] = "open"
        topic.custom_fields[:snoozed_until] = nil
      end
    end

    topic.save_custom_fields
  end
end
