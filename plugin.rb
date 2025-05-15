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
    last_assigned_at: :datetime,
    last_action_by_assignee_at: :datetime,
    priority: :string,
    product_area: :string,
    status: :string,
    snoozed_until: :datetime,
    waiting_since: :datetime
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

  on(:topic_created) do |topic, _opts, _user|
    topic.custom_fields[:assignee_id] = 0
    topic.custom_fields[:status] = "new"
    topic.custom_fields[:waiting_since] = Time.now.utc
    topic.save_custom_fields
  end

  on(:post_created) do |post, _opts, user|
    topic = post.topic

    if user.admin
      # check if user is an admin and update the `waiting_since` field, if so
      topic.custom_fields[:waiting_since] = Time.now.utc
      topic.save_custom_fields
    elsif topic.custom_fields[:status] == "snoozed"
      # check if new post belongs to a snoozed topic and update status
      topic.custom_fields[:status] = "open"
      topic.custom_fields[:snoozed_until] = nil
      topic.save_custom_fields
    end
  end
end
