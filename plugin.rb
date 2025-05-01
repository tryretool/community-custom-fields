# frozen_string_literal: true

# name: community-custom-fields
# about: Adds custom fields for using Discourse as a support platform
# url: https://github.com/tryretool/community-custom-fields
# version: 0.1
# authors: Retool

enabled_site_setting :community_custom_fields_enabled

module ::CommunityCustomFields
  PLUGIN_NAME = "community-custom-fields"
end

require_relative 'lib/community_custom_fields/engine.rb'

after_initialize do
  Topic.register_custom_field_type('assignee_id', :integer)
  Topic.register_custom_field_type('status', :string)

  TopicList.preloaded_custom_fields << 'assignee_id' << 'status'
  
  add_to_serializer(:topic_view, :custom_fields) do
    object.topic.custom_fields.slice('assignee_id', 'status')
  end

  on(:topic_created) do |topic, params, user|
    topic.custom_fields["assignee_id"] ||= 0
    topic.custom_fields["status"] ||= "new"
    topic.save_custom_fields
  end
end
