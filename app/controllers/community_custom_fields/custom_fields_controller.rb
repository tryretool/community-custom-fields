# frozen_string_literal: true

class CommunityCustomFields::CustomFieldsController < ::ApplicationController
  requires_plugin CommunityCustomFields::PLUGIN_NAME

  before_action :ensure_logged_in
  before_action :ensure_admin

  def update
    topic = Topic.unscoped.find(params[:topic_id])
    fields = custom_fields_params

    if fields.key?("status") && !CommunityCustomFields::STATUSES.include?(fields["status"])
      return render json: { error: "Invalid status: #{fields["status"].inspect}" }, status: 422
    end

    previous_status = topic.custom_fields["status"]
    previous_assignee_id = topic.custom_fields["assignee_id"]
    topic.custom_fields.merge!(fields)
    if topic.save_custom_fields
      CommunityCustomFields::TopicStatusChange.record(
        topic: topic,
        from_status: previous_status,
        source: "api_update",
        assignee_id: previous_assignee_id,
        user_id: current_user.id
      )
      topic.touch
      render json: success_json
    else
      Rails.logger.error("Failed to save custom fields for topic #{topic.id}: #{topic.errors.full_messages}")
      render json: { error: topic.errors.full_messages }, status: 422
    end
  end

  private

  def custom_fields_params
    params.require(:custom_field).permit(*CommunityCustomFields::CUSTOM_FIELDS.keys)
  end
end