# frozen_string_literal: true

# name: community-custom-fields
# about: Adds custom fields for using Discourse as a support platform
# url: https://github.com/tryretool/community-custom-fields
# version: 0.1
# authors: Retool

enabled_site_setting :community_custom_fields_enabled

module ::CommunityCustomFields
  PLUGIN_NAME = "community-custom-fields"
  CUSTOM_FIELD_NAMES = %i[
    assignee_id
    first_assigned_to_id
    first_assigned_at
    last_assigned_at
    last_action_by_assignee_at
    priority
    product_area
    status
    snoozed_until
  ]
  CUSTOM_FIELD_TYPES = %i[
    integer
    integer
    datetime
    datetime
    datetime
    string
    string
    string
    datetime
  ]
end

require_relative 'lib/community_custom_fields/engine.rb'

after_initialize do
  CommunityCustomFields::CUSTOM_FIELD_NAMES.each_with_index do |field, i|
    Topic.register_custom_field_type(field, CommunityCustomFields::CUSTOM_FIELD_TYPES[i])
  end

  TopicList.preloaded_custom_fields.merge(CommunityCustomFields::CUSTOM_FIELD_NAMES)
  
  add_to_serializer(:topic_view, :custom_fields) do
    object.topic.custom_fields.slice(*CommunityCustomFields::CUSTOM_FIELD_NAMES)
  end

  on(:topic_created) do |topic, params, user|
    topic.custom_fields[:status] = "new"
    topic.save_custom_fields
  end
end
