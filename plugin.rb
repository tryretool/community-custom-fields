# frozen_string_literal: true

# name: community-custom-fields
# about: Adds custom fields for using Discourse as a support platform
# url: 
# version: 0.1
# authors: Retool

enabled_site_setting :community_custom_fields_enabled

after_initialize do
  module ::CommunityCustomFields
    class Engine < ::Rails::Engine
      engine_name "community_custom_fields"
      isolate_namespace CommunityCustomFields
      config.autoload_paths << File.join(config.root, "lib")
      scheduled_job_dir = "#{config.root}/app/jobs/scheduled"
      config.to_prepare do
        Rails.autoloaders.main.eager_load_dir(scheduled_job_dir) if Dir.exist?(scheduled_job_dir)
      end
    end
  end

  #############################################################################
  # /config/routes.rb

  CommunityCustomFields::Engine.routes.draw do
    put '/:topic_id' => 'custom_fields#update'
  end

  Discourse::Application.routes.append do
    mount ::CommunityCustomFields::Engine, at: '/admin/plugins/community-custom-fields'
  end

  #############################################################################

  require_dependency 'application_controller'
  class CommunityCustomFields::CustomFieldsController < ::ApplicationController
    before_action :ensure_logged_in
    before_action :ensure_admin

    def update
      topic = Topic.find(params[:topic_id])
      custom = params[:custom_field] || params.permit(:assignee_id, :status)
      topic.custom_fields["assignee_id"] = custom[:assignee_id].to_i if custom[:assignee_id].present?
      topic.custom_fields["status"] = custom[:status] if custom[:status].present?
      if topic.save_custom_fields
        render json: success_json
      else
        Rails.logger.error("Failed to save custom fields for topic #{topic.id}: #{topic.errors.full_messages}")
        render json: { error: topic.errors.full_messages }, status: 422
      end
    end
  end

  #############################################################################

  Topic.register_custom_field_type('assignee_id', :integer)
  Topic.register_custom_field_type('status', :string)

  TopicList.preloaded_custom_fields << 'assignee_id' << 'status'
  
  add_to_serializer(:topic_view, :custom_fields) do
    object.topic.custom_fields.slice('assignee_id', 'status')
  end

  on(:topic_created) do |topic, params, user|
    topic.custom_fields["assignee_id"] ||= 0  # or any default value
    topic.custom_fields["status"] ||= "new"
    topic.save_custom_fields
  end
end
